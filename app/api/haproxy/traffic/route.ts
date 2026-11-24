import { requireSession } from '@/lib/session';
import { ok, handleError } from '@/lib/api';
import { sshExec } from '@/lib/ssh';
import { getSSHConfig } from '@/lib/helpers';
import { proxyServers } from '@/lib/haproxy/internal';
import {
  analyseCommand,
  discoverCommand,
  parseAnalysis,
  parseDiscovery,
  DEFAULT_LINE_LIMIT,
  MAX_LINE_LIMIT,
  type AccessLogStats,
  type Counted,
  type LogSource,
} from '@/lib/haproxy/access-log';
import { geoipTable } from '@/lib/geoip/store';
import { lookupCountry } from '@/lib/geoip/format';
import type { Server } from '@/lib/types';

/**
 * Wer auf den Reverse-Proxy zugreift: Adressen, Länder, Pfade, Statuscodes.
 *
 * Die Ergänzung zu `/api/haproxy/stats`. Dort steht, wie viel lief — hier, von
 * wem. Beides sind verschiedene Quellen und deshalb zwei Routen: die Zeitreihe
 * kommt aus der Datenbank und ist billig, diese hier wertet das Zugriffslog
 * aus.
 *
 * ── Warum sie NICHT gepollt wird ──
 *
 * Ein Lauf liest bis zu 200 000 Zeilen. Das ist eine Handlung, kein
 * Hintergrundtakt — die Seite holt ihn beim Öffnen und danach nur auf Knopfdruck
 * oder bei einem Wechsel des Dienstes. Deshalb steht auch dabei, wann er lief.
 *
 * ── Warum die Adressen nicht an den Browser gehen ──
 *
 * Aus dem Log kommen bis zu 3000 Adressen zurück, gebraucht werden sie für
 * die Länderverteilung. Zurück an den Browser gehen fünfzig. Nicht aus
 * Sparsamkeit: eine vollständige Liste der Besucheradressen ist nichts, was
 * in einem Browser-Tab liegen muss, damit ein Balkendiagramm daraus wird.
 */

const IP_ROWS = 50;
const PATH_ROWS = 25;
const PROBE_MS = 120_000;

interface ProxyTraffic {
  serverId: string;
  serverName: string;
  /** Woher gelesen wurde. `none` heißt: kein Log gefunden — und das ist eine
   *  Auskunft, keine Null. */
  source: LogSource['kind'];
  logPath: string | null;
  stats: AccessLogStats | null;
  error: string | null;
}

export async function GET(request: Request) {
  try {
    await requireSession();

    const url = new URL(request.url);
    const backend = url.searchParams.get('scope')?.trim() || undefined;
    const only = url.searchParams.get('serverId')?.trim() || undefined;
    const lines = clamp(
      Number(url.searchParams.get('lines') ?? DEFAULT_LINE_LIMIT),
      1000,
      MAX_LINE_LIMIT
    );

    const all = await proxyServers();
    const servers = only ? all.filter((server) => server.$id === only) : all;

    // Einzeln scheitern lassen: eine Maschine, die gerade nicht antwortet, ist
    // eine Auskunft und kein Grund, die übrigen wegzulassen.
    const results: ProxyTraffic[] = await Promise.all(
      servers.map((server) => analyse(server, backend, lines))
    );

    const stats = results.map((row) => row.stats).filter((s): s is AccessLogStats => s !== null);

    /*
     * Die Länder aus den Adressen, bestimmt mit der Tabelle in `lib/geoip/`:
     * so geht keine Besucheradresse an einen fremden Dienst.
     */
    const table = await geoipTable();
    const byCountry = new Map<string, number>();
    let covered = 0;
    let unknown = 0;
    for (const entry of stats.flatMap((s) => s.ips)) {
      covered += entry.count;
      const code = lookupCountry(table, entry.key);
      if (!code) {
        unknown += entry.count;
        continue;
      }
      byCountry.set(code, (byCountry.get(code) ?? 0) + entry.count);
    }

    const parsed = sum(stats.map((s) => s.parsed));

    return ok({
      collectedAt: new Date().toISOString(),
      scope: backend ?? null,
      lines,
      proxies: results.map((row) => ({
        serverId: row.serverId,
        serverName: row.serverName,
        source: row.source,
        logPath: row.logPath,
        error: row.error,
        lines: row.stats?.lines ?? null,
        parsed: row.stats?.parsed ?? null,
        from: row.stats?.from ?? null,
        to: row.stats?.to ?? null,
      })),
      totals: {
        lines: sum(stats.map((s) => s.lines)),
        parsed,
        bytes: sum(stats.map((s) => s.bytes)),
        /*
         * Die Summe über die Maschinen und nicht die Zahl verschiedener
         * Adressen: dieselbe Adresse auf zwei Proxys wäre hier zweimal gezählt.
         * Sie zusammenzuführen ginge nur mit den vollständigen Listen, und die
         * sind absichtlich gekappt. Bei einer Maschine — dem Normalfall — stimmt
         * die Zahl exakt; bei mehreren ist sie eine Obergrenze, und die
         * Oberfläche sagt das.
         */
        uniqueIps: sum(stats.map((s) => s.uniqueIps)),
        uniqueIpsExact: stats.length <= 1,
        from: earliest(stats.map((s) => s.from)),
        to: latest(stats.map((s) => s.to)),
      },
      countries: [...byCountry.entries()]
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count),
      /**
       * Welcher Anteil der Anfragen in der Länderverteilung steckt.
       *
       * Die Adressliste ist gekappt (siehe `IP_LIMIT`), also deckt die
       * Verteilung nicht zwangsläufig alles ab. Diese Zahl steht neben dem
       * Diagramm — eine Verteilung ohne sie behauptete Vollständigkeit, die sie
       * nicht hat.
       */
      countryCoverage: parsed > 0 ? covered / parsed : null,
      countryUnknown: unknown,
      geoipAvailable: table !== null,
      ips: mergeCounted(stats.flatMap((s) => s.ips)).slice(0, IP_ROWS),
      paths: mergeCounted(stats.flatMap((s) => s.paths)).slice(0, PATH_ROWS),
      statusCodes: mergeCounted(stats.flatMap((s) => s.statusCodes)),
      methods: mergeCounted(stats.flatMap((s) => s.methods)),
      hours: mergeHours(stats),
      backends: mergeBackends(stats),
    });
  } catch (err) {
    return handleError(err);
  }
}

/** Eine Maschine: Quelle suchen, auswerten. */
async function analyse(
  server: Server,
  backend: string | undefined,
  lines: number
): Promise<ProxyTraffic> {
  const base = { serverId: server.$id, serverName: server.name };
  try {
    const ssh = await getSSHConfig(server);
    const found = parseDiscovery((await sshExec(ssh, discoverCommand(), 30_000)).stdout);

    if (found.kind === 'none') {
      return {
        ...base,
        source: 'none',
        logPath: null,
        stats: null,
        error:
          'Es wurde kein HAProxy-Log gefunden. HAPM schreibt das Log des HAProxy-Containers nach ' +
          '/var/log/haproxy/haproxy.log mit. Liegt dort nichts, hat HAProxy noch keine Anfrage ' +
          'protokolliert oder läuft nicht.',
      };
    }

    const result = await sshExec(
      ssh,
      analyseCommand({ source: found, backend, lines }),
      PROBE_MS
    );

    return {
      ...base,
      source: found.kind,
      logPath: found.kind === 'file' ? found.path : null,
      stats: parseAnalysis(result.stdout),
      error: null,
    };
  } catch (err) {
    return {
      ...base,
      source: 'none',
      logPath: null,
      stats: null,
      error: err instanceof Error ? err.message : 'HAProxy ist nicht erreichbar.',
    };
  }
}

/* ── Zusammenführen ── */

function mergeCounted(entries: Counted[]): Counted[] {
  const merged = new Map<string, number>();
  for (const entry of entries) merged.set(entry.key, (merged.get(entry.key) ?? 0) + entry.count);
  return [...merged.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
}

function mergeHours(stats: AccessLogStats[]) {
  const merged = new Map<string, number>();
  for (const entry of stats.flatMap((s) => s.hours)) {
    merged.set(entry.hour, (merged.get(entry.hour) ?? 0) + entry.count);
  }
  return [...merged.entries()]
    .map(([hour, count]) => ({ hour, count }))
    .sort((a, b) => a.hour.localeCompare(b.hour));
}

function mergeBackends(stats: AccessLogStats[]) {
  const merged = new Map<string, AccessLogStats['backends'][number]>();
  for (const entry of stats.flatMap((s) => s.backends)) {
    const found = merged.get(entry.backend);
    if (!found) {
      merged.set(entry.backend, { ...entry });
      continue;
    }
    found.requests += entry.requests;
    found.http2xx += entry.http2xx;
    found.http3xx += entry.http3xx;
    found.http4xx += entry.http4xx;
    found.http5xx += entry.http5xx;
    found.httpOther += entry.httpOther;
    found.bytes += entry.bytes;
  }
  return [...merged.values()].sort((a, b) => b.requests - a.requests);
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function earliest(values: (string | null)[]): string | null {
  const known = values.filter((value): value is string => value !== null).sort();
  return known[0] ?? null;
}

function latest(values: (string | null)[]): string | null {
  const known = values.filter((value): value is string => value !== null).sort();
  return known[known.length - 1] ?? null;
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, Math.floor(value)));
}
