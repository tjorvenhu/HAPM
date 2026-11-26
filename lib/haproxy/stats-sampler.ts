/**
 * Der Sampler für die Sekundenwerte: liest HAProxy im Sekundentakt, solange
 * jemand hinsieht.
 *
 * Gerechnet wird in `./stats-seconds.ts`, hier wird gefragt und gepuffert.
 *
 * ── Nachfragegetrieben ──
 *
 * Jede Abfrage der Kacheln (`/api/haproxy/stats/live/now`) ruft `demandSeconds`
 * und hält damit die Erfassung am Leben. Kommt `SECONDS_IDLE_MS` lang keine,
 * hört sie auf. Ohne offene Seite fragt HAPM HAProxy also nur einmal je Minute
 * (der Minutensammler), mit offener Seite einmal je Sekunde, egal wie viele
 * Tabs offen sind: es gibt genau eine Schleife im Prozess, und sie wartet jede
 * Probe ab, bevor sie die nächste plant. Zwei Abfragen am Socket gleichzeitig
 * gibt es dadurch nie.
 *
 * ── Warum `node:net` und nicht `socat` ──
 *
 * Der Minutensammler geht über `sshExec` (bash, zweimal `socat`). Das sind drei
 * Prozesse je Probe, im Sekundentakt das Teuerste an der ganzen Sache. Der
 * Stats-Socket liegt im geteilten Volume `/run/haproxy` und ist von hier aus
 * direkt erreichbar, genauso wie `bin/hapm-ctl.mjs` den Master-Socket
 * erreicht. Eine Verbindung je Probe, kein Kindprozess.
 *
 * Eine dauerhaft offene Verbindung (`prompt`-Modus) wäre noch billiger, aber
 * nicht nötig: der Aufbau einer Unix-Verbindung kostet Mikrosekunden, und
 * nach einem Reload gehört der Socket einem neuen Prozess. Eine offene
 * Verbindung hinge dann am alten, bis er sich beendet.
 *
 * Die Proben liegen nur im Speicher, auf `globalThis` wie der Scheduler, damit
 * ein HMR-Neuaufbau im Dev-Modus weder die Proben noch die laufende Schleife
 * verdoppelt.
 */

import { localServer } from '../helpers';
import { parseProcessInfo, parseStatRows } from './stats-parse';
import { readConfiguredStatsSocket, rememberedStatsSocket, trafficRows } from './stats-collect';
import { askStatsSocket } from './stats-socket';
import {
  prune,
  SECONDS_IDLE_MS,
  SECONDS_SAMPLE_MS,
  slimRows,
  splitInfoAndStat,
  type SecondSample,
} from './stats-seconds';

/** Wie lange eine Probe auf HAProxy wartet. Eine normale dauert Millisekunden. */
const PROBE_TIMEOUT_MS = 2_000;

/** Nach einem Fehlschlag: so lange bis zum nächsten Versuch. */
const RETRY_MS = 5_000;

/**
 * So selten wird `haproxy.cfg` nach dem Socket gelesen, wenn er fehlt. Das
 * Lesen ist ein Kindprozess (`cat` über `sshExec`), und eine Installation ohne
 * Stats-Socket soll nicht jede Sekunde einen starten.
 */
const LOOKUP_MS = 30_000;

interface SamplerState {
  samples: SecondSample[];
  /** Die letzte Abfrage einer Seite. */
  demandAt: number;
  running: boolean;
  socket: string | null;
  lookedUpAt: number;
}

const g = globalThis as typeof globalThis & { __hapm_stats_sampler?: SamplerState };
if (!g.__hapm_stats_sampler) {
  g.__hapm_stats_sampler = {
    samples: [],
    demandAt: 0,
    running: false,
    socket: null,
    lookedUpAt: 0,
  };
}
const state = g.__hapm_stats_sampler;

/**
 * Eine Seite will Sekundenwerte. Startet die Schleife, wenn sie nicht läuft,
 * und gibt die Proben zurück, die schon da sind.
 */
export function demandSeconds(now = Date.now()): SecondSample[] {
  state.demandAt = now;
  if (!state.running) {
    state.running = true;
    void loop();
  }
  return state.samples;
}

async function loop(): Promise<void> {
  try {
    while (Date.now() - state.demandAt <= SECONDS_IDLE_MS) {
      const started = Date.now();
      const sample = await probe();
      if (sample) {
        state.samples = prune([...state.samples, sample], sample.at);
      }
      const pause = sample ? SECONDS_SAMPLE_MS - (Date.now() - started) : RETRY_MS;
      await sleep(Math.max(pause, 50));
    }
  } finally {
    state.running = false;
  }
}

/** Eine Probe, oder `null`, wenn HAProxy gerade nichts sagt. Wirft nie. */
async function probe(): Promise<SecondSample | null> {
  const socket = await socketPath();
  if (!socket) return null;
  try {
    const text = await askStatsSocket(socket, 'show info;show stat', PROBE_TIMEOUT_MS);
    const at = Date.now();
    const { info, stat } = splitInfoAndStat(text);
    const rows = trafficRows(parseStatRows(stat));
    if (rows.length > 0) return { at, uptimeSec: parseProcessInfo(info).uptimeSec, rows: slimRows(rows) };
  } catch {
    // Unten: der Pfad taugt nicht mehr.
  }
  // Nichts gekommen: beim nächsten Versuch den Pfad neu bestimmen.
  state.socket = null;
  return null;
}

async function socketPath(): Promise<string | null> {
  if (state.socket) return state.socket;
  const server = localServer();
  const remembered = rememberedStatsSocket(server.$id);
  if (remembered) return (state.socket = remembered);
  if (Date.now() - state.lookedUpAt < LOOKUP_MS) return null;
  state.lookedUpAt = Date.now();
  try {
    return (state.socket = await readConfiguredStatsSocket(server));
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
