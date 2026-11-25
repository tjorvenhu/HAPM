/**
 * Die Sekundenwerte der Live-Kacheln: aus den Proben des Samplers
 * (`stats-sampler.ts`) gerechnet.
 *
 * Der Minutensammler (`stats-collect.ts`) schreibt eine Runde je Minute in die
 * Datenbank. Für eine Kachel, die „jetzt" heißt, ist das zu träge: die Zahl ist
 * bis zu einer Minute alt. Solange jemand eine Seite mit Live-Kacheln offen
 * hat, liest der Sampler HAProxy deshalb jede Sekunde und hält die Proben im
 * Speicher. In die Datenbank gehen sie nicht, die Zeitreihe bleibt beim
 * Minutensammler.
 *
 * Rein und ohne Laufzeit-Importe außer zwei reinen Modulen: die Kacheln
 * importieren von hier den Takt und das Zusammenführen mit den Minutenwerten.
 *
 * ── Warum aus Zählerständen und nicht aus Differenzen je Probe ──
 *
 * Eine Probe hält die rohen Zähler seit dem Start des Prozesses. Jedes Fenster
 * ist damit die Differenz zweier beliebiger Proben, nicht die Summe vieler
 * kleiner Differenzen: eine Pause des Samplers dazwischen (niemand hatte die
 * Seite offen) ändert an der Summe nichts. Was sie ungültig macht, ist nur ein
 * Neustart des Prozesses dazwischen (`sameProcess`).
 */

import type { StatCounters, StatKind } from './stats-parse';
import { counterDelta } from './stats-parse';
import { LIVE_ERROR_MINUTES, type LiveCurrent } from './stats-live';

/**
 * Takt des Samplers.
 *
 * Eine Probe ist ein Verbindungsaufbau zum Unix-Socket, `show info;show stat`
 * und das Lesen der CSV: gegen HAProxy 3.0 mit 80 Abschnitten rund 2 ms (siehe
 * docs/reverse-proxy.md, „Die Sekundenwerte"). Eine Sekunde ist damit billig
 * und so fein, wie eine Zahl auf dem Schirm noch lesbar ist.
 */
export const SECONDS_SAMPLE_MS = 1_000;

/** Wie oft die Kacheln fragen. Halber Takt würde jede Probe zweimal holen. */
export const SECONDS_POLL_MS = 2_000;

/**
 * Wie lange der Sampler ohne Abfrage weiterläuft.
 *
 * Etwas mehr als zehn Takte der Kacheln: ein verzögerter Poll (Tab im
 * Hintergrund wieder vorn, langsames Netz) startet nichts neu, eine
 * geschlossene Seite hält ihn höchstens eine halbe Minute am Leben.
 */
export const SECONDS_IDLE_MS = 30_000;

/** So weit reichen die Proben zurück. Genau das Fenster der Fehlerquote. */
export const SECONDS_BUFFER_MS = LIVE_ERROR_MINUTES * 60_000;

/**
 * Über so viele Sekunden wird eine Rate gebildet.
 *
 * Eine einzelne Sekunde springt bei wenig Verkehr zwischen 0 und 2 Anfragen
 * hin und her, die Zahl wäre unlesbar. Fünf Sekunden bleiben „jetzt" und
 * glätten genug, dass die Ziffern nicht flackern.
 */
export const SECONDS_RATE_MS = 5_000;

/**
 * Ab wann die letzte Probe nicht mehr „jetzt" ist. Danach stehen die
 * Minutenwerte da (`mergeLive`), nicht die letzte Sekundenzahl.
 */
export const SECONDS_STALE_MS = 10_000;

/**
 * Wie weit die Laufzeit von HAProxy hinter der Uhr zurückbleiben darf, bevor
 * es als Neustart gilt. `Uptime_sec` hat ganze Sekunden, und zwischen der
 * Antwort und dem Zeitstempel der Probe liegt etwas Zeit.
 */
const UPTIME_SLACK_SEC = 3;

/** Spielraum, ab dem die Proben das Fenster der Fehlerquote abdecken. */
const SHARE_SLACK_MS = 15_000;

/** Was eine Probe je Abschnitt behält. Der Rest von `StatCounters` braucht hier niemand. */
export interface SecondRow {
  scope: string;
  kind: StatKind;
  requests: number | null;
  http4xx: number | null;
  http5xx: number | null;
  bytesIn: number | null;
  bytesOut: number | null;
  sessionsCurrent: number | null;
  responseMs: number | null;
}

export interface SecondSample {
  /** Millisekunden seit Epoch. */
  at: number;
  uptimeSec: number | null;
  rows: SecondRow[];
}

export function slimRows(rows: StatCounters[]): SecondRow[] {
  return rows.map((row) => ({
    scope: row.scope,
    kind: row.kind,
    requests: row.requests,
    http4xx: row.http4xx,
    http5xx: row.http5xx,
    bytesIn: row.bytesIn,
    bytesOut: row.bytesOut,
    sessionsCurrent: row.sessionsCurrent,
    responseMs: row.responseMs,
  }));
}

export interface SecondStats {
  /** Zeit der letzten Probe, `null` vor der ersten. */
  latestAt: string | null;
  /** Die letzte Probe ist älter als `SECONDS_STALE_MS`: `current` ist leer. */
  stale: boolean;
  /** Je Wert `null`, wenn die Proben ihn (noch) nicht hergeben. */
  current: LiveCurrent;
}

const EMPTY: LiveCurrent = {
  requestsPerSec: null,
  bytesInPerSec: null,
  bytesOutPerSec: null,
  responseMs: null,
  sessions: null,
  share5xx: null,
  share4xx: null,
};

/**
 * Gehören zwei Proben zu demselben HAProxy-Prozess?
 *
 * Nicht nur „die Laufzeit ist gesunken": nach einer Pause des Samplers kann
 * ein neuer Prozess schon länger laufen, als der alte bei der vorigen Probe
 * lief. Er muss aber mindestens so lange laufen, wie seit der vorigen Probe
 * vergangen ist. Ohne bekannte Laufzeit bleibt der Rücksprung der Zähler
 * (`counterDelta`) als Schutz.
 */
export function sameProcess(older: SecondSample, newer: SecondSample): boolean {
  if (older.uptimeSec === null || newer.uptimeSec === null) return true;
  const elapsedSec = (newer.at - older.at) / 1000;
  return newer.uptimeSec >= older.uptimeSec + elapsedSec - UPTIME_SLACK_SEC;
}

/** Die Proben in die Reihenfolge der Zeit, ohne die vor dem letzten Neustart. */
function currentProcess(samples: SecondSample[]): SecondSample[] {
  const sorted = [...samples].sort((a, b) => a.at - b.at);
  let start = sorted.length - 1;
  while (start > 0 && sameProcess(sorted[start - 1], sorted[start])) start--;
  return sorted.slice(Math.max(start, 0));
}

/** Gehört die Zeile zur Auswahl, und trägt sie Flussgrößen? */
function pick(row: SecondRow, scope: string | undefined): { flow: boolean; response: boolean } | null {
  if (scope) {
    if (row.kind !== 'backend' || row.scope !== scope) return null;
    return { flow: true, response: true };
  }
  // Wie die Übersicht: Flussgrößen aus den Frontends, Antwortzeit aus den
  // Backends (ein Frontend misst keine, siehe `foldInBackends`).
  return { flow: row.kind === 'frontend', response: row.kind === 'backend' };
}

const keyOf = (row: SecondRow) => `${row.kind}|${row.scope}`;

/**
 * Die Summe der Differenzen eines Zählers zwischen zwei Proben.
 *
 * Abschnitte, die in der älteren fehlen, zählen nicht: sie sind gerade erst
 * entstanden, und ihr ganzer Stand wäre keine Differenz. Springt ein Zähler
 * zurück, ist die Summe unbekannt und nicht kleiner.
 */
function sumDelta(
  base: SecondSample,
  head: SecondSample,
  scope: string | undefined,
  field: 'requests' | 'http4xx' | 'http5xx' | 'bytesIn' | 'bytesOut'
): number | null {
  const before = new Map(base.rows.map((row) => [keyOf(row), row]));
  let total: number | null = null;
  for (const row of head.rows) {
    if (!pick(row, scope)?.flow) continue;
    const previous = before.get(keyOf(row));
    if (!previous || row[field] === null) continue;
    const delta = counterDelta(previous[field], row[field]);
    if (delta === null) return null;
    total = (total ?? 0) + delta;
  }
  return total;
}

/**
 * Die älteste Probe, die höchstens `windowMs` vor der letzten liegt. `null`,
 * wenn es außer der letzten keine gibt.
 */
function baseWithin(samples: SecondSample[], windowMs: number): SecondSample | null {
  const head = samples[samples.length - 1];
  for (const sample of samples) {
    if (sample === head) return null;
    if (head.at - sample.at <= windowMs) return sample;
  }
  return null;
}

/**
 * Die Sekundenwerte aus den Proben.
 *
 * Ohne `scope` wie die Übersicht der Statistik, mit `scope` alles aus der
 * Backend-Zeile dieses Dienstes, dieselbe Regel wie `liveStats`.
 */
export function secondStats(samples: SecondSample[], now: number, scope?: string): SecondStats {
  if (samples.length === 0) return { latestAt: null, stale: true, current: EMPTY };

  const segment = currentProcess(samples);
  const head = segment[segment.length - 1];
  const latestAt = new Date(head.at).toISOString();
  if (now - head.at > SECONDS_STALE_MS) return { latestAt, stale: true, current: EMPTY };

  // Der Momentanwert steht schon in der ersten Probe.
  let sessions: number | null = null;
  for (const row of head.rows) {
    if (!pick(row, scope)?.flow || row.sessionsCurrent === null) continue;
    sessions = (sessions ?? 0) + row.sessionsCurrent;
  }

  let requestsPerSec: number | null = null;
  let bytesInPerSec: number | null = null;
  let bytesOutPerSec: number | null = null;
  const rateBase = baseWithin(segment, SECONDS_RATE_MS);
  if (rateBase) {
    const seconds = (head.at - rateBase.at) / 1000;
    const perSec = (value: number | null) => (value === null ? null : value / seconds);
    requestsPerSec = perSec(sumDelta(rateBase, head, scope, 'requests'));
    bytesInPerSec = perSec(sumDelta(rateBase, head, scope, 'bytesIn'));
    bytesOutPerSec = perSec(sumDelta(rateBase, head, scope, 'bytesOut'));
  }

  /*
   * Die Quote gilt für `LIVE_ERROR_MINUTES`, wie die Beschriftung der Kachel
   * sagt. Decken die Proben das noch nicht ab (der Sampler läuft erst seit
   * einer halben Minute), gibt es hier keine: eine 503 unter zwanzig Anfragen
   * wären sonst fünf Prozent. Dann steht die Quote aus den Minutenwerten da.
   */
  const windowMs = LIVE_ERROR_MINUTES * 60_000;
  const shareBase = baseWithin(segment, windowMs + SHARE_SLACK_MS);
  let share5xx: number | null = null;
  let share4xx: number | null = null;
  if (shareBase && head.at - shareBase.at >= windowMs - SHARE_SLACK_MS) {
    const requests = sumDelta(shareBase, head, scope, 'requests');
    if (requests !== null && requests > 0) {
      const http5xx = sumDelta(shareBase, head, scope, 'http5xx');
      const http4xx = sumDelta(shareBase, head, scope, 'http4xx');
      share5xx = http5xx === null ? null : http5xx / requests;
      share4xx = http4xx === null ? null : http4xx / requests;
    }
  }

  /*
   * Die Antwortzeit ist schon ein Mittel (HAProxy: über die letzten 1024
   * Antworten). Gewichtet wird mit den Anfragen über die ganze Spanne der
   * Proben und nicht über fünf Sekunden: in fünf Sekunden hat bei wenig
   * Verkehr kein Ziel geantwortet, und die Zahl fiele dauernd auf die
   * Minutenwerte zurück. Ein Ziel ohne Anfragen in der Spanne zählt nicht.
   */
  let responseMs: number | null = null;
  const weightBase = segment.length > 1 ? segment[0] : null;
  if (weightBase) {
    const before = new Map(weightBase.rows.map((row) => [keyOf(row), row]));
    let top = 0;
    let bottom = 0;
    for (const row of head.rows) {
      if (!pick(row, scope)?.response || row.responseMs === null) continue;
      const previous = before.get(keyOf(row));
      if (!previous) continue;
      const weight = counterDelta(previous.requests, row.requests);
      if (weight === null || weight <= 0) continue;
      top += row.responseMs * weight;
      bottom += weight;
    }
    if (bottom > 0) responseMs = Math.round(top / bottom);
  }

  return {
    latestAt,
    stale: false,
    current: { requestsPerSec, bytesInPerSec, bytesOutPerSec, responseMs, sessions, share5xx, share4xx },
  };
}

/**
 * Je Kennzahl der Sekundenwert, wenn es ihn gibt, sonst der aus der letzten
 * Minutenrunde, sonst unbekannt. Eine 0 aus den Sekundenwerten ist eine
 * Messung („keine Anfrage in fünf Sekunden") und gewinnt.
 */
export function mergeLive(minutes: LiveCurrent | null, seconds: LiveCurrent | null): LiveCurrent {
  const current = { ...EMPTY };
  for (const key of Object.keys(EMPTY) as (keyof LiveCurrent)[]) {
    current[key] = seconds?.[key] ?? minutes?.[key] ?? null;
  }
  return current;
}

/** Proben, die älter als der Puffer sind, fallen weg. Für den Sampler. */
export function prune(samples: SecondSample[], now: number): SecondSample[] {
  const since = now - SECONDS_BUFFER_MS - SHARE_SLACK_MS;
  let first = 0;
  while (first < samples.length && samples[first].at < since) first++;
  return first === 0 ? samples : samples.slice(first);
}

/**
 * Die Antwort auf `show info;show stat` in ihre zwei Teile.
 *
 * Beide Kommandos gehen in EINER Verbindung (HAProxy trennt mit `;`), damit
 * zwischen Laufzeit und Zählern kein Reload liegt. Getrennt wird an der
 * Kopfzeile der CSV und nicht an einer Leerzeile: wie viele Leerzeilen
 * HAProxy zwischen zwei Antworten schreibt, ist nicht festgelegt.
 */
export function splitInfoAndStat(text: string): { info: string; stat: string } {
  const match = /^# ?pxname,/m.exec(text);
  if (!match) return { info: text, stat: '' };
  return { info: text.slice(0, match.index), stat: text.slice(match.index) };
}
