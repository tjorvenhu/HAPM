/**
 * Eine Erfassungsrunde für die Reverse-Proxy-Zeitreihe: abfragen, gegen die
 * vorige Probe rechnen, wegschreiben.
 *
 * Aufgeteilt wie überall in diesem Repo: `./stats-parse.ts` rechnet und ist
 * rein, hier wird geredet und entschieden, was in der Datenbank landet.
 *
 * ── Warum das bezahlbar ist ──
 *
 * `show stat` gilt für den ganzen Proxy: EINE Runde trägt die Zahlen ALLER
 * Dienste. Der Aufwand wächst nicht mit den Diensten — vierzig Einträge sind
 * eine Abfrage je Takt und nicht vierzig.
 *
 * ── Warum nicht `probeProxy()` aus `provision.ts` ──
 *
 * Das holt zusätzlich `haproxy -v`, die Prüfsumme der Datei, den acme.sh-Test
 * und die DNS-Hooks und parst die ganze Konfiguration. Für ein paar Zahlen im
 * Minutentakt ist das ein Vielfaches an Arbeit.
 */

import { createDocument, listAll, Query } from '../db';
import { COLLECTIONS } from '../types';
import { sshExec } from '../ssh';
import { getSSHConfig } from '../helpers';
import { buildCommand, shellEscape } from '../shell';
import { HAPROXY_CFG, parseStatsSocket } from './config';
import { proxyServers } from './internal';
import {
  hasMeasurement,
  parseProcessInfo,
  parseStatRows,
  statRates,
  type StatCounters,
  type StatSnapshot,
} from './stats-parse';
import type { HaproxyMetric, Server } from '../types';

/**
 * Der Takt — definiert in `./stats-series.ts` und hier nur weitergereicht.
 *
 * Dort, weil die Oberfläche ihn ebenfalls braucht (die Live-Kennzahlen in
 * `./stats-live.ts` rechnen damit) und diese Datei über `lib/db` und `lib/ssh` nichts ist, was eine
 * Client-Komponente importieren darf. Hier, weil der Scheduler ihn bei der
 * Erfassung sucht und nicht bei der Darstellung.
 */
export { HAPROXY_METRICS_INTERVAL_MS } from './stats-series';

/**
 * Wie lange die Zeilen bleiben.
 *
 * Eigene Aufbewahrung und nicht die der Protokolle, weil das hier keins ist.
 * **Vierzehn Tage**, weil der Takt eine Minute ist: ein Proxy mit vierzig
 * Diensten schreibt rund 60 000 Zeilen am Tag. Dreißig Tage wären fast zwei
 * Millionen Zeilen für einen Streifen, den niemand einen Monat rückwärts
 * scrollt; vierzehn decken jeden Vergleich ab, den man an dieser Stelle
 * anstellt („mehr los als letzte Woche?").
 */
export const HAPROXY_METRICS_RETENTION_DAYS = 14;

/** Wie lange eine Runde auf eine Maschine wartet. */
const PROBE_MS = 30_000;

/**
 * Die vorigen Rohstände, im Prozess und nicht in der Datenbank.
 *
 * Sie werden nur bis zur nächsten Runde gebraucht, und ein Lesevorgang je
 * Abschnitt und Takt verdoppelte den Datenverkehr für eine Zahl, die zwei
 * Zeiger weiter im Speicher liegt.
 *
 * Der Preis ist sichtbar und gewollt: nach einem Neustart von HAPM hat die
 * erste Runde keine Differenzen, die Kurve hat für einen Punkt eine Lücke. Eine
 * Lücke ist die ehrliche Darstellung; eine 0 wäre ein erfundenes ruhiges
 * Fenster.
 *
 * Der Schlüssel ist `serverId|kind|scope`. Auf `globalThis` wie der Scheduler,
 * damit ein HMR-Neuaufbau im Dev-Modus die Historie nicht wegwirft.
 */
const g = globalThis as typeof globalThis & {
  __hapm_haproxy_stat?: Map<string, StatSnapshot>;
  __hapm_haproxy_socket?: Map<string, string>;
};
if (!g.__hapm_haproxy_stat) g.__hapm_haproxy_stat = new Map();
if (!g.__hapm_haproxy_socket) g.__hapm_haproxy_socket = new Map();
const lastSeen = g.__hapm_haproxy_stat;

/**
 * Der Pfad des Stats-Sockets, gemerkt.
 *
 * Er steht in `haproxy.cfg` und wird von dort gelesen, nicht geraten. Gelesen
 * wird die Datei aber nur, wenn der gemerkte Pfad nichts liefert. Im
 * Minutentakt jedes Mal die ganze Konfiguration zu lesen wäre der teuerste
 * Teil einer Runde, für eine Zeile, die sich praktisch nie ändert.
 *
 * Die Selbstheilung steckt in der Bedingung: liefert `show stat` über den
 * gemerkten Pfad nichts, wird die Datei neu gelesen. Damit findet die nächste
 * Runde einen umgezogenen Socket von selbst, ohne dass jemand HAPM neu
 * starten muss.
 */
const socketOf = g.__hapm_haproxy_socket;

function keyFor(serverId: string, counters: StatCounters): string {
  return `${serverId}|${counters.kind}|${counters.scope}`;
}

export interface HaproxyMetricsRunResult {
  written: number;
  /** Wie viele Maschinen geantwortet haben. */
  proxies: number;
  /**
   * Was schiefging, je Maschine eine Zeile. Eine stumme Maschine ist kein Grund,
   * die anderen wegzuwerfen — deshalb steht sie hier statt in einer Ausnahme.
   */
  errors: string[];
}

/* ══════════════════════════════════════════════════════════════════════
 * Die Quelle
 * ══════════════════════════════════════════════════════════════════════ */

interface Probe {
  rows: StatCounters[];
  uptimeSec: number | null;
}

/**
 * Eine Maschine abfragen.
 *
 * Der Pfad des Stats-Sockets steht in der Konfiguration und wird GELESEN, nicht
 * geraten: `/run/haproxy/admin.sock` und `/var/run/haproxy.sock` sind beide
 * üblich, und wer rät, findet bei der Hälfte der Konfigurationen nichts und
 * hielte das für „keine Anfragen".
 *
 * `show stat` und `show info` gehen in EINEM Kommando über denselben Socket.
 * Zwischen zwei Kommandos könnte ein Reload liegen, nach dem die Laufzeit
 * nicht mehr zu den Zählern passt.
 */
async function probeProxyStats(server: Server): Promise<Probe> {
  const ssh = await getSSHConfig(server);

  const remembered = socketOf.get(server.$id);
  if (remembered) {
    const probe = await askSocket(ssh, remembered);
    if (probe.rows.length > 0) return probe;
    // Nichts gekommen: der Pfad taugt nicht mehr. Einmal nachsehen und, wenn
    // auch das nichts bringt, den gemerkten wegwerfen — sonst hinge die
    // Erfassung an einer Zeile von vorgestern.
    socketOf.delete(server.$id);
  }

  const socket = await readConfiguredStatsSocket(server);
  // Kein Socket heißt: HAProxy sagt hier nichts. Das ist eine Auskunft, die es
  // nicht gibt, und kein Fehler — dieselbe Regel wie beim Zustand der Ziele.
  if (!socket) return { rows: [], uptimeSec: null };

  const probe = await askSocket(ssh, socket);
  if (probe.rows.length > 0) socketOf.set(server.$id, socket);
  return probe;
}

/**
 * Der Pfad des Stats-Sockets, wie er in `haproxy.cfg` steht. `null`, wenn dort
 * keiner steht oder die Datei nicht lesbar ist.
 */
export async function readConfiguredStatsSocket(server: Server): Promise<string | null> {
  const config = await sshExec(
    await getSSHConfig(server),
    `${buildCommand(['cat', HAPROXY_CFG])} 2>/dev/null || true`,
    PROBE_MS
  );
  return parseStatsSocket(config.stdout);
}

/** Der Pfad, über den die letzte Runde geantwortet hat. Für den Sampler (`stats-sampler.ts`). */
export function rememberedStatsSocket(serverId: string): string | null {
  return socketOf.get(serverId) ?? null;
}

/** `show stat` und `show info` über EINEN Socket, in einem Kommando. */
async function askSocket(
  ssh: Awaited<ReturnType<typeof getSSHConfig>>,
  socket: string
): Promise<Probe> {
  const escaped = shellEscape(socket);
  const result = await sshExec(
    ssh,
    `printf 'show stat\\n' | socat -t 2 stdio ${escaped} 2>/dev/null; ` +
      `printf '%s\\n' '${SPLIT}'; ` +
      `printf 'show info\\n' | socat -t 2 stdio ${escaped} 2>/dev/null; true`,
    PROBE_MS
  );

  const [stat = '', info = ''] = result.stdout.split(`${SPLIT}\n`);
  return { rows: parseStatRows(stat), uptimeSec: parseProcessInfo(info).uptimeSec };
}

/**
 * Die Trennmarke zwischen den beiden Antworten.
 *
 * Sie steht als Literal im Kommando und enthält deshalb nichts, was eine Shell
 * anfassen würde. Ein Doppelpunkt-Präfix, das in keiner CSV-Kopfzeile und in
 * keinem `Name: Wert` von `show info` vorkommt — träfe die Marke eine echte
 * Zeile, landete der halbe `show stat` im Info-Teil.
 */
const SPLIT = '__HAPM_SPLIT__';

/* ══════════════════════════════════════════════════════════════════════
 * Der Durchlauf
 * ══════════════════════════════════════════════════════════════════════ */

/** Eine Runde. Wirft nie: was schiefging, steht in `errors`. */
export async function collectHaproxyMetrics(now = Date.now()): Promise<HaproxyMetricsRunResult> {
  const errors: string[] = [];
  const at = new Date(now).toISOString();

  let servers: Server[] = [];
  try {
    servers = await proxyServers();
  } catch (err) {
    return { written: 0, proxies: 0, errors: [`Reverse-Proxy nicht ladbar: ${message(err)}`] };
  }

  // Aufräumen, damit die Zustandskarten nicht mit entfernten Maschinen wachsen.
  const live = new Set(servers.map((server) => server.$id));
  for (const key of lastSeen.keys()) {
    if (!live.has(key.slice(0, key.indexOf('|')))) lastSeen.delete(key);
  }
  for (const id of socketOf.keys()) {
    if (!live.has(id)) socketOf.delete(id);
  }

  let written = 0;
  let reached = 0;

  for (const server of servers) {
    let probe: Probe;
    try {
      probe = await probeProxyStats(server);
      reached++;
    } catch (err) {
      errors.push(`HAProxy: ${message(err)}`);
      continue;
    }

    /*
     * Ein Abschnitt, der in dieser Runde fehlt, wird NICHT vergessen: sein
     * voriger Stand bleibt stehen. Beim nächsten Erfolg entscheidet dann
     * `usableGap`, ob der Abstand noch als Fenster taugt — und wenn nicht, ist
     * die Antwort eine Lücke und keine aufsummierte Spitze.
     */
    for (const counters of probe.rows) {
      const key = keyFor(server.$id, counters);
      const current: StatSnapshot = { at: now, counters, uptimeSec: probe.uptimeSec };
      const rates = statRates(lastSeen.get(key) ?? null, current);
      lastSeen.set(key, current);

      // Kein Messwert, keine Zeile.
      if (!hasMeasurement(rates)) continue;

      try {
        await createDocument<HaproxyMetric>(COLLECTIONS.HAPROXY_METRICS, {
          serverId: server.$id,
          scope: counters.scope,
          kind: counters.kind,
          collectedAt: at,
          ...rates,
        });
        written++;
      } catch (err) {
        errors.push(`Zeile für ${counters.scope}: ${message(err)}`);
      }
    }
  }

  return { written, proxies: reached, errors };
}

/**
 * Die Zeitreihe eines Zeitraums.
 *
 * Eigene Funktion statt einer Abfrage in der Route, weil beide Seiten der
 * Statistik-Seite sie brauchen: die Übersicht über alle Frontends und die
 * Aufschlüsselung eines einzelnen Dienstes.
 */
export async function readHaproxyMetrics(options: {
  since: string;
  kind?: 'frontend' | 'backend';
  serverId?: string;
  scope?: string;
}): Promise<HaproxyMetric[]> {
  const filters = [Query.greaterThanEqual('collectedAt', options.since)];
  if (options.kind) filters.push(Query.equal('kind', options.kind));
  if (options.serverId) filters.push(Query.equal('serverId', options.serverId));
  if (options.scope) filters.push(Query.equal('scope', options.scope));

  const rows = await listAll<HaproxyMetric>(COLLECTIONS.HAPROXY_METRICS, filters);
  rows.sort((a, b) => a.collectedAt.localeCompare(b.collectedAt));
  return rows;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
