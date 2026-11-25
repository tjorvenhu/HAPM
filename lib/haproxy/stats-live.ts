/**
 * Die Live-Kennzahlen: was gerade über HAProxy läuft.
 *
 * Gelesen wird dieselbe Zeitreihe wie auf der Statistik-Seite
 * (`haproxy_metrics`), nur die letzte halbe Stunde und nicht gerastert. Daraus
 * kommen die Verlaufslinien der Kacheln und ihre Zahl, solange es keinen
 * Sekundenwert gibt. Die Sekundenwerte selbst rechnet `stats-seconds.ts` aus
 * den Proben des Samplers, nicht aus dieser Tabelle.
 *
 * Rein und ohne Laufzeit-Importe außer zwei reinen Modulen: die Seiten
 * importieren von hier den Takt.
 *
 * ── Warum nach Runden und nicht nach Raster ──
 *
 * `bucketise` legt Zeilen in Minutenfenster. Für die Kurve ist das richtig,
 * für eine Rate nicht: der Takt ist `setInterval` und wandert, und dann liegen
 * zwei Runden in einem Fenster und keine im nächsten. Anfragen pro Sekunde
 * verdoppelten sich für einen Punkt und fielen danach auf „unbekannt". Eine
 * Runde schreibt alle ihre Zeilen mit DEMSELBEN `collectedAt`, und ihre
 * Differenzen gelten seit der vorigen Runde. Der Abstand zweier Runden ist
 * damit genau das Fenster, über das gezählt wurde.
 */

import type { HaproxyMetric } from '../types';
import { HAPROXY_METRICS_INTERVAL_MS } from './stats-series';
import { MAX_GAP_MS } from './stats-parse';

/** Wie weit die Verlaufslinie zurückreicht. */
export const LIVE_WINDOW_MINUTES = 30;

/**
 * Wie oft die Seiten fragen.
 *
 * Ein Viertel des Erfassungstakts: eine neue Runde steht damit höchstens
 * fünfzehn Sekunden später da. Schneller hieße, die Datenbank viermal mehr für
 * dieselbe Antwort zu fragen. Die Zahlen der Kacheln kommen ohnehin im
 * Sekundentakt aus `stats-seconds.ts`, von hier nur Linie und Rückfall.
 */
export const LIVE_POLL_MS = 15_000;

/** Über so viele Minuten wird die Fehlerquote gebildet. Aus einer Minute mit
 *  zwanzig Anfragen macht eine einzige 503 sonst fünf Prozent. */
export const LIVE_ERROR_MINUTES = 5;

/**
 * Ab wann die letzte Runde nicht mehr „jetzt" ist: drei verpasste Takte.
 * Danach stehen Striche statt der letzten Zahl, denn eine eingefrorene Rate
 * sieht aus wie ein ruhiger Betrieb.
 */
export const LIVE_STALE_MS = 3 * HAPROXY_METRICS_INTERVAL_MS;

/**
 * Ab welchem Anteil an Serverfehlern die Kachel warnt. Ein Prozent 5xx ist auf
 * einem gesunden Proxy schon viel, fünf heißt: ein Ziel ist kaputt. Für 4xx
 * gibt es keine Schwelle, die meisten davon schicken Scanner.
 */
export const ERROR_WARN_SHARE = 0.01;
export const ERROR_DANGER_SHARE = 0.05;

export function errorTone(share: number | null): 'warning' | 'danger' | undefined {
  if (share === null) return undefined;
  if (share >= ERROR_DANGER_SHARE) return 'danger';
  if (share >= ERROR_WARN_SHARE) return 'warning';
  return undefined;
}

/** Eine Runde des Sammlers, auf Sekunden umgerechnet. */
export interface LiveRound {
  at: string;
  requestsPerSec: number | null;
  bytesInPerSec: number | null;
  bytesOutPerSec: number | null;
  /** Nach Anfragen gewichtetes Mittel aus den Backends. */
  responseMs: number | null;
  sessions: number | null;
  /** Anteil 5xx an den Anfragen dieser Runde, für die Verlaufslinie. */
  share5xx: number | null;
  share4xx: number | null;
}

export interface LiveCurrent {
  requestsPerSec: number | null;
  bytesInPerSec: number | null;
  bytesOutPerSec: number | null;
  responseMs: number | null;
  sessions: number | null;
  /** Über `LIVE_ERROR_MINUTES`. `null` auch, wenn darin keine Anfrage kam:
   *  ohne Anfragen gibt es keine Quote, auch keine von null Prozent. */
  share5xx: number | null;
  share4xx: number | null;
}

export interface LiveStats {
  /** Die letzte Runde, `null` vor der ersten. */
  latestAt: string | null;
  /** Die letzte Runde ist älter als `LIVE_STALE_MS`: `current` ist leer. */
  stale: boolean;
  current: LiveCurrent;
  /** Älteste zuerst. Ohne die erste Runde im Fenster: ihr fehlt die Vorgängerin
   *  und damit die Länge ihres Fensters. */
  rounds: LiveRound[];
  windowMinutes: number;
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

interface Totals {
  requests: number | null;
  http4xx: number | null;
  http5xx: number | null;
  bytesInKb: number | null;
  bytesOutKb: number | null;
  sessions: number | null;
  weighted: { top: number; bottom: number };
}

/**
 * Die Live-Kennzahlen aus den Zeilen der letzten Minuten.
 *
 * Ohne `scope` wie die Übersicht der Statistik: die Flussgrößen aus den
 * FRONTENDS, die Antwortzeit aus den BACKENDS (ein Frontend misst keine,
 * Begründung bei `foldInBackends`). Mit `scope` alles aus der Backend-Zeile
 * dieses Dienstes.
 */
export function liveStats(rows: HaproxyMetric[], now: number, scope?: string): LiveStats {
  const rounds = new Map<string, Totals>();
  const totalsOf = (at: string) => {
    let totals = rounds.get(at);
    if (!totals) {
      totals = {
        requests: null,
        http4xx: null,
        http5xx: null,
        bytesInKb: null,
        bytesOutKb: null,
        sessions: null,
        weighted: { top: 0, bottom: 0 },
      };
      rounds.set(at, totals);
    }
    return totals;
  };

  for (const row of rows) {
    if (scope && (row.kind !== 'backend' || row.scope !== scope)) continue;
    const totals = totalsOf(row.collectedAt);
    const flow = scope ? true : row.kind === 'frontend';
    if (flow) {
      totals.requests = add(totals.requests, row.requests);
      totals.http4xx = add(totals.http4xx, row.http4xx);
      totals.http5xx = add(totals.http5xx, row.http5xx);
      totals.bytesInKb = add(totals.bytesInKb, row.bytesInKb);
      totals.bytesOutKb = add(totals.bytesOutKb, row.bytesOutKb);
      totals.sessions = add(totals.sessions, row.sessionsCurrent);
    }
    if (row.kind === 'backend' && row.responseMs !== null && row.responseMs !== undefined) {
      // Wie `bucketise`: ohne bekannte Anfragen zählt die Zeile einfach. Mit
      // null Anfragen zählt sie nicht, ein Ziel ohne Verkehr hat gerade keine
      // Antwortzeit.
      const weight = row.requests ?? 1;
      totals.weighted.top += row.responseMs * weight;
      totals.weighted.bottom += weight;
    }
  }

  const times = [...rounds.keys()]
    .filter((at) => Number.isFinite(Date.parse(at)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));

  const out: LiveRound[] = [];
  for (let i = 1; i < times.length; i++) {
    const at = times[i];
    const gap = Date.parse(at) - Date.parse(times[i - 1]);
    const seconds = gap > 0 && gap <= MAX_GAP_MS ? gap / 1000 : null;
    const totals = rounds.get(at)!;
    const perSec = (value: number | null, factor = 1) =>
      value === null || seconds === null ? null : (value * factor) / seconds;
    out.push({
      at,
      requestsPerSec: perSec(totals.requests),
      bytesInPerSec: perSec(totals.bytesInKb, 1024),
      bytesOutPerSec: perSec(totals.bytesOutKb, 1024),
      responseMs:
        totals.weighted.bottom > 0 ? Math.round(totals.weighted.top / totals.weighted.bottom) : null,
      sessions: totals.sessions,
      share5xx: share(totals.http5xx, totals.requests),
      share4xx: share(totals.http4xx, totals.requests),
    });
  }

  const latestAt = times.length > 0 ? times[times.length - 1] : null;
  const stale = latestAt === null || now - Date.parse(latestAt) > LIVE_STALE_MS;

  let current = EMPTY;
  if (!stale && latestAt !== null) {
    /*
     * Je Kennzahl die jüngste Runde, die sie kennt, solange die nicht selbst
     * veraltet ist. Nach jedem Reload von HAProxy fehlen in einer Runde die
     * Differenzen. Sonst stünde nach jeder Änderung an einem Ziel eine Minute
     * lang ein Strich, obwohl die Zahl von vor einer Minute noch stimmt.
     */
    const fresh = out.filter((round) => now - Date.parse(round.at) <= LIVE_STALE_MS);
    const newest = <K extends keyof LiveRound>(key: K): LiveRound[K] | null => {
      for (let i = fresh.length - 1; i >= 0; i--) {
        const value = fresh[i][key];
        if (value !== null) return value;
      }
      return null;
    };
    const latest = rounds.get(latestAt)!;

    // Die Quote über die letzten Minuten. Gezählt werden nur Runden, in denen
    // Anfragen UND Statusklasse bekannt sind: sonst stünde eine Summe über
    // fünf Minuten gegen Anfragen aus vieren.
    const since = Date.parse(latestAt) - LIVE_ERROR_MINUTES * 60_000;
    let requests = 0;
    let http5xx = 0;
    let http4xx = 0;
    let known5xx = false;
    let known4xx = false;
    for (const at of times) {
      if (Date.parse(at) <= since) continue;
      const totals = rounds.get(at)!;
      if (totals.requests === null) continue;
      if (totals.http5xx !== null) {
        http5xx += totals.http5xx;
        known5xx = true;
      }
      if (totals.http4xx !== null) {
        http4xx += totals.http4xx;
        known4xx = true;
      }
      requests += totals.requests;
    }

    current = {
      requestsPerSec: newest('requestsPerSec'),
      bytesInPerSec: newest('bytesInPerSec'),
      bytesOutPerSec: newest('bytesOutPerSec'),
      responseMs: newest('responseMs'),
      // Ein Momentanwert, den schon die erste Probe kennt: aus der letzten Runde.
      sessions: latest.sessions,
      share5xx: known5xx && requests > 0 ? http5xx / requests : null,
      share4xx: known4xx && requests > 0 ? http4xx / requests : null,
    };
  }

  return { latestAt, stale, current, rounds: out, windowMinutes: LIVE_WINDOW_MINUTES };
}

function add(a: number | null, b: number | null | undefined): number | null {
  if (b === null || b === undefined) return a;
  return (a ?? 0) + b;
}

function share(part: number | null, whole: number | null): number | null {
  if (part === null || whole === null || whole <= 0) return null;
  return part / whole;
}
