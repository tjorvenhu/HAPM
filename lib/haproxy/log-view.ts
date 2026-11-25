/**
 * Die letzten Zeilen des HAProxy-Logs, lesbar gemacht.
 *
 * Die Statistik (`./access-log.ts`) zählt das Log mit `awk` auf der Maschine
 * aus, weil sie über Hunderttausende Zeilen rechnet. Hier geht es um wenige
 * hundert, die ein Mensch liest: die Seite „Reverse-Proxy → Logs" zeigt sie
 * einzeln. Dafür reicht ein `tail -n`, und die Zerlegung läuft hier in
 * JavaScript, wo sie sich ohne Shell prüfen lässt.
 *
 * Wie bei `./access-log.ts` redet diese Datei mit niemandem: sie baut das
 * Kommando und zerlegt die Ausgabe. Kein Import aus `lib/db`, `lib/ssh` oder
 * `lib/docker`, damit die Seite die Typen und die Filter benutzen kann.
 *
 * ── Was in der Datei steht ──
 *
 * Der Mitschnitt (`lib/haproxy-log.ts`) schreibt jede Zeile aus dem Log des
 * Containers als `2026-11-24T14:00:00Z haproxy: <text>`. Der Text ist, was
 * HAProxy mit `log stdout format raw` schreibt, also ohne syslog-Kopf:
 *
 *  - eine Anfrage (`option httplog`):
 *    `203.0.113.7:54321 [24/Nov/2026:14:00:00.123] https~ be_app/srv1 0/0/1/23/24 200 1500 - - ---- 1/1/0/0/0 0/0 "GET / HTTP/1.1"`
 *  - eine TCP-Verbindung (`option tcplog`, die TCP-Weiterleitungen):
 *    `203.0.113.7:54321 [24/Nov/2026:14:00:00.123] tcp_db tcp_db/srv1 1/0/5 123 -- 1/1/0/0/0 0/0`
 *  - ein Verbindungsfehler vor der ersten Anfrage:
 *    `203.0.113.7:54321 [24/Nov/2026:14:00:00.123] https/1: SSL handshake failure`
 *  - eine Meldung von HAProxy selbst, meist von stderr:
 *    `[NOTICE]   (1) : New worker (8) forked`, `Server be_app/srv1 is DOWN, …`
 *
 * Was keiner Form entspricht, kommt als rohe Zeile zurück und nicht gar nicht:
 * eine Zeile, die der Zerleger nicht kennt, ist meist genau die, nach der
 * jemand sucht.
 */

import { buildCommand } from '../shell';

/* ══════════════════════════════════════════════════════════════════════
 * Grenzen
 * ══════════════════════════════════════════════════════════════════════ */

/** Wie viele Zeilen die Seite anbietet. Die erste ist die Vorgabe. */
export const LOG_LINE_STEPS = [200, 500, 1000, 2000] as const;
export const DEFAULT_LOG_LINES = LOG_LINE_STEPS[0];
export const MAX_LOG_LINES = LOG_LINE_STEPS[LOG_LINE_STEPS.length - 1];

/**
 * Wie weit ein Filter zurücksucht.
 *
 * Ohne Filter liest die Route genau so viele Zeilen, wie sie zeigt. Mit Filter
 * reicht das nicht: unter den letzten 200 Zeilen ist auf einem belebten Proxy
 * selten ein 5xx. Gesucht wird deshalb in einem festen, größeren Fenster, und
 * die Antwort sagt, wie groß es war. Ein Datum als Grenze läse die Datei ganz,
 * dieselbe Überlegung wie bei der Statistik.
 */
export const FILTER_WINDOW = 20_000;

/** Eine Zeile, die länger ist, wird gekürzt. Sie geht so an den Browser. */
export const MAX_LINE_CHARS = 2000;

/** Wie lang der Suchtext sein darf. Er bleibt in Node und geht in kein Kommando. */
export const MAX_QUERY_CHARS = 200;

export function clampLines(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LOG_LINES;
  return Math.min(MAX_LOG_LINES, n);
}

/**
 * Das Kommando, das die letzten `lines` Zeilen liest.
 *
 * Der Pfad kommt vom Aufrufer aus einer Konstanten, nie aus einer Eingabe. Die
 * Zahl wird hier noch einmal geklemmt: sie entscheidet, wie viel gelesen wird.
 */
export function tailCommand(path: string, lines: number): string {
  const n = Math.min(FILTER_WINDOW, Math.max(1, Math.floor(lines) || 1));
  return buildCommand(['tail', '-n', String(n), '--', path]);
}

/* ══════════════════════════════════════════════════════════════════════
 * Zerlegen
 * ══════════════════════════════════════════════════════════════════════ */

export type LogLevel = 'notice' | 'warning' | 'alert';

interface EntryBase {
  /** Zeitpunkt aus dem Kopf des Mitschnitts, ISO in UTC. `null`, wenn die
   *  Zeile keinen trägt (eine Datei, die rsyslog geschrieben hat). */
  time: string | null;
  /** Der Text nach dem Kopf, gekürzt auf `MAX_LINE_CHARS`. */
  text: string;
}

export interface RequestEntry extends EntryBase {
  kind: 'request';
  clientIp: string;
  frontend: string;
  backend: string | null;
  server: string | null;
  /** `null` bei `<BADREQ>` und einer Anfrage ohne Zeile. */
  method: string | null;
  path: string | null;
  /** `null`, wenn HAProxy -1 schreibt: es kam keine Antwort. */
  status: number | null;
  /** Gesamtdauer in ms (`Ta`). `null` bei -1. */
  durationMs: number | null;
  bytes: number | null;
  /** Wie die Sitzung endete, `----` ist der Normalfall. */
  termination: string;
}

export interface TcpEntry extends EntryBase {
  kind: 'tcp';
  clientIp: string;
  frontend: string;
  backend: string | null;
  server: string | null;
  durationMs: number | null;
  bytes: number | null;
  termination: string;
}

export interface ConnectionEntry extends EntryBase {
  kind: 'connection';
  clientIp: string;
  frontend: string;
  message: string;
}

export interface SystemEntry extends EntryBase {
  kind: 'system';
  level: LogLevel;
  message: string;
}

export interface RawEntry extends EntryBase {
  kind: 'raw';
}

export type LogEntry = RequestEntry | TcpEntry | ConnectionEntry | SystemEntry | RawEntry;

/** Der Kopf, den `formatLogLine` in `lib/haproxy-log.ts` schreibt. */
const MIRROR_HEAD = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) haproxy: ?/;

/** Ein syslog-Kopf, wie rsyslog ihn schreibt: `Feb  6 12:14:14 lb1 haproxy[1234]: `. */
const SYSLOG_HEAD = /^[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \S+ haproxy(?:\[\d+\])?: /;

const HTTP_LINE =
  /^(\S+) \[([^\]]+)\] (\S+) (\S+) (\S+) (-?\d+) \+?(-?\d+) \S+ \S+ (\S+) \S+ \S+(?: \{.*?\})*(?: "(.*)")?\s*$/;

const TCP_LINE = /^(\S+) \[([^\]]+)\] (\S+) (\S+) (-?\d+\/-?\d+\/\+?-?\d+) \+?(-?\d+) (\S{2}) \S+ \S+\s*$/;

const CONNECTION_LINE = /^(\S+) \[([^\]]+)\] (\S+): (.+)$/;

const LEVEL_PREFIX = /^\[(NOTICE|WARNING|ALERT|EMERG|INFO|DEBUG|DIAG)\]\s*(?:\(\d+\)\s*)?:\s*(.*)$/;

/**
 * Meldungen ohne Präfix, die HAProxy über `log` schreibt (Zustand von Servern
 * und Abschnitten). Die Stufe steht nicht in der Zeile, sie kommt aus dem
 * Wortlaut.
 */
const PLAIN_MESSAGES: { pattern: RegExp; level: LogLevel }[] = [
  { pattern: /^backend \S+ has no server available!/, level: 'alert' },
  { pattern: /^(?:Backup )?Server \S+ is (?:DOWN|going DOWN)\b/, level: 'warning' },
  { pattern: /^Health check for (?:backup )?server \S+ failed\b/, level: 'warning' },
  { pattern: /^(?:Backup )?Server \S+ is (?:UP|going UP|stopped|MAINT|DRAIN)\b/, level: 'notice' },
  { pattern: /^Health check for (?:backup )?server \S+ succeeded\b/, level: 'notice' },
  { pattern: /^(?:Proxy|Frontend|Backend) \S+ (?:started|stopped|paused|resumed)\b/, level: 'notice' },
  { pattern: /^Stopping (?:proxy|frontend|backend) \S+/, level: 'notice' },
];

const LEVELS: Record<string, LogLevel> = {
  NOTICE: 'notice',
  INFO: 'notice',
  DEBUG: 'notice',
  DIAG: 'notice',
  WARNING: 'warning',
  ALERT: 'alert',
  EMERG: 'alert',
};

/**
 * Die Adresse ohne Port.
 *
 * Von RECHTS getrennt, wie in `./access-log.ts`: bei IPv6 enthält die Adresse
 * selbst Doppelpunkte, und von links käme `2001` heraus.
 */
export function stripPort(address: string): string {
  const bracketed = /^\[(.+)\](?::\d+)?$/.exec(address);
  if (bracketed) return bracketed[1];
  return address.replace(/:\d+$/, '');
}

function splitBackend(field: string): { backend: string | null; server: string | null } {
  const cut = field.indexOf('/');
  const backend = cut === -1 ? field : field.slice(0, cut);
  const server = cut === -1 ? null : field.slice(cut + 1);
  return {
    backend: backend && backend !== '-' ? backend : null,
    server: server && !server.startsWith('<') && server !== '-' ? server : null,
  };
}

/** Der letzte Wert der Zeiten (`Ta` bzw. `Tt`), `+` von `option logasap` weg. */
function totalTime(timers: string): number | null {
  const last = timers.split('/').pop() ?? '';
  const value = Number(last.replace(/^\+/, ''));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function count(value: string): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** `https~` ist das Frontend `https` über TLS. Das Zeichen sagt in der Liste nichts. */
function frontendName(field: string): string {
  return field.endsWith('~') ? field.slice(0, -1) : field;
}

function parseRequestLine(request: string | undefined): { method: string | null; path: string | null } {
  if (!request) return { method: null, path: null };
  if (request === '<BADREQ>') return { method: null, path: request };
  const parts = request.split(' ');
  if (parts.length === 1) return { method: null, path: parts[0] };
  return { method: parts[0] || null, path: parts[1] || null };
}

/** Eine Zeile der Datei. Leere Zeilen liefern `null`. */
export function parseLogLine(raw: string): LogEntry | null {
  let line = raw.replace(/\r$/, '');
  if (line.trim() === '') return null;

  let time: string | null = null;
  const mirror = MIRROR_HEAD.exec(line);
  if (mirror) {
    time = mirror[1];
    line = line.slice(mirror[0].length);
  } else {
    const syslog = SYSLOG_HEAD.exec(line);
    if (syslog) line = line.slice(syslog[0].length);
  }

  const text = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;

  const http = HTTP_LINE.exec(line);
  if (http) {
    const { backend, server } = splitBackend(http[4]);
    const status = Number(http[6]);
    return {
      kind: 'request',
      time,
      text,
      clientIp: stripPort(http[1]),
      frontend: frontendName(http[3]),
      backend,
      server,
      ...parseRequestLine(http[9]),
      status: status >= 100 ? status : null,
      durationMs: totalTime(http[5]),
      bytes: count(http[7]),
      termination: http[8],
    };
  }

  const tcp = TCP_LINE.exec(line);
  if (tcp) {
    const { backend, server } = splitBackend(tcp[4]);
    return {
      kind: 'tcp',
      time,
      text,
      clientIp: stripPort(tcp[1]),
      frontend: frontendName(tcp[3]),
      backend,
      server,
      durationMs: totalTime(tcp[5]),
      bytes: count(tcp[6]),
      termination: tcp[7],
    };
  }

  const connection = CONNECTION_LINE.exec(line);
  if (connection) {
    return {
      kind: 'connection',
      time,
      text,
      clientIp: stripPort(connection[1]),
      frontend: frontendName(connection[3]),
      message: connection[4].trim(),
    };
  }

  const prefixed = LEVEL_PREFIX.exec(line);
  if (prefixed) {
    return { kind: 'system', time, text, level: LEVELS[prefixed[1]], message: prefixed[2].trim() };
  }

  for (const { pattern, level } of PLAIN_MESSAGES) {
    if (pattern.test(line)) return { kind: 'system', time, text, level, message: line.trim() };
  }

  return { kind: 'raw', time, text };
}

/** Die Ausgabe von `tail`, neueste Zeile zuerst. */
export function parseLogOutput(stdout: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of stdout.split('\n')) {
    const entry = parseLogLine(line);
    if (entry) entries.push(entry);
  }
  return entries.reverse();
}

/* ══════════════════════════════════════════════════════════════════════
 * Filtern
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * Was die Auswahl auf der Seite anbietet.
 *
 * `system` ist alles, was nicht von einem Client kommt: Start, Reload,
 * Zustand der Server, Fehler in der Konfiguration, und die Zeilen, die der
 * Zerleger nicht kennt. `problems` davon nur Warnungen und Fehler.
 */
export const LOG_FILTERS = ['all', 'requests', '2xx', '3xx', '4xx', '5xx', 'system', 'problems'] as const;
export type LogFilter = (typeof LOG_FILTERS)[number];

export function isLogFilter(value: unknown): value is LogFilter {
  return typeof value === 'string' && (LOG_FILTERS as readonly string[]).includes(value);
}

export function matchesFilter(entry: LogEntry, filter: LogFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'requests':
      return entry.kind === 'request' || entry.kind === 'tcp' || entry.kind === 'connection';
    case '2xx':
    case '3xx':
    case '4xx':
    case '5xx':
      return entry.kind === 'request' && entry.status !== null && String(entry.status)[0] === filter[0];
    case 'system':
      return entry.kind === 'system' || entry.kind === 'raw';
    case 'problems':
      return entry.kind === 'system' && entry.level !== 'notice';
  }
}

/** Groß- und Kleinschreibung zählt nicht, gesucht wird in der ganzen Zeile. */
export function matchesQuery(entry: LogEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return entry.text.toLowerCase().includes(needle);
}

export interface FilteredLog {
  entries: LogEntry[];
  /** Wie viele Zeilen insgesamt passten. Kann größer sein als `entries`. */
  matched: number;
}

/** Filter und Suche, dann die ersten `limit` (also die neuesten). */
export function filterEntries(
  entries: LogEntry[],
  options: { filter: LogFilter; query: string; limit: number }
): FilteredLog {
  const hits = entries.filter(
    (entry) => matchesFilter(entry, options.filter) && matchesQuery(entry, options.query)
  );
  return { entries: hits.slice(0, options.limit), matched: hits.length };
}

/* ══════════════════════════════════════════════════════════════════════
 * Die Antwort der Route
 * ══════════════════════════════════════════════════════════════════════ */

export interface HaproxyLogView {
  collectedAt: string;
  file: string;
  /** `false` heißt: die Datei gibt es nicht. Dann sind `entries` leer, und das
   *  ist keine Auskunft über den Verkehr. */
  exists: boolean;
  size: number | null;
  modifiedAt: string | null;
  follower: {
    /** Läuft der Mitschnitt überhaupt (nur unter Linux, nach dem Start des Schedulers)? */
    started: boolean;
    /** Hängt er gerade am Log des Containers? */
    connected: boolean;
    /** Zeitstempel der letzten Zeile, die er geschrieben hat. */
    last: string | null;
  };
  filter: LogFilter;
  query: string;
  limit: number;
  /** Wie viele Zeilen gelesen wurden: `limit` ohne Filter, `FILTER_WINDOW` mit. */
  window: number;
  /** Wie viele davon tatsächlich da waren. Kleiner als `window` heißt: das ist die ganze Datei. */
  scanned: number;
  matched: number;
  entries: LogEntry[];
}
