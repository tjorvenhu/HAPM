/**
 * Die Ausgabe der Container von CrowdSec und des Bouncers als Zeilen mit
 * Feldern. Beide schreiben im Textformat von logrus:
 *
 *   time="2026-11-26T11:12:39+01:00" level=info msg="…" module=lapi
 *
 * Die lokale API protokolliert jede Anfrage als `msg`, in der Form eines
 * Zugriffslogs (`172.18.0.3 - [Datum] "GET /v1/… HTTP/1.1 200 22.2ms "UA" ""`).
 * Solche Zeilen sind Routine (der Bouncer fragt alle zehn Sekunden), und die
 * Seite blendet sie auf Wunsch aus.
 *
 * Rein, damit sich jede Form an einem Beispiel prüfen lässt
 * (`tests/crowdsec/log-lines.test.ts`). Was sich nicht lesen lässt, bleibt als
 * Text in `message` stehen.
 */

import { goDurationMs } from './data';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warning' | 'error' | 'fatal' | 'panic';

export interface CrowdsecApiRequest {
  client: string;
  method: string;
  path: string;
  status: number;
  /** Aus der Dauer in der Schreibweise von Go (`22.28ms`, `416µs`, `1.2s`). */
  durationMs: number | null;
  agent: string | null;
}

export interface CrowdsecLogLine {
  time: string | null;
  level: LogLevel | null;
  message: string;
  /** Alle übrigen Felder (`module`, `component`, `type`, …). */
  fields: Record<string, string>;
  request: CrowdsecApiRequest | null;
  /** Eine Anfrage an die lokale API ohne Fehler: der Normalbetrieb. */
  routine: boolean;
}

const LEVELS: Record<string, LogLevel> = {
  trace: 'trace',
  debug: 'debug',
  info: 'info',
  warn: 'warning',
  warning: 'warning',
  error: 'error',
  fatal: 'fatal',
  panic: 'panic',
};

/** `key=value` und `key="value mit \"Anführungszeichen\""`, der Reihe nach. */
export function parseLogfmt(line: string): Record<string, string> | null {
  const fields: Record<string, string> = {};
  let i = 0;
  let found = false;
  while (i < line.length) {
    while (line[i] === ' ') i++;
    const keyStart = i;
    while (i < line.length && /[A-Za-z0-9_.\-]/.test(line[i])) i++;
    const key = line.slice(keyStart, i);
    if (!key || line[i] !== '=') return found ? fields : null;
    i++;
    let value = '';
    if (line[i] === '"') {
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length) {
          const next = line[i + 1];
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          i += 2;
        } else {
          value += line[i++];
        }
      }
      i++;
    } else {
      const start = i;
      while (i < line.length && line[i] !== ' ') i++;
      value = line.slice(start, i);
    }
    fields[key] = value;
    found = true;
  }
  return found ? fields : null;
}

const API_REQUEST =
  // Am Ende steht der Referer, bei CrowdSec 1.8 als `"` ohne Gegenstück: der
  // Rest der Zeile zählt deshalb nicht.
  /^(\S+) - \[[^\]]*\] "(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\S+) HTTP\/[\d.]+ (\d{3}) (\S+) "([^"]*)"(?:\s.*)?$/;

export function parseApiRequest(message: string): CrowdsecApiRequest | null {
  const match = API_REQUEST.exec(message.trim());
  if (!match) return null;
  return {
    client: match[1],
    method: match[2],
    path: match[3],
    status: Number(match[4]),
    durationMs: goDurationMs(match[5]),
    agent: match[6] || null,
  };
}

function isoOrNull(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export function parseCrowdsecLogLine(raw: string): CrowdsecLogLine {
  const line = raw.trimEnd();
  const fields = line.startsWith('time=') ? parseLogfmt(line) : null;
  if (!fields || !('msg' in fields)) {
    return { time: null, level: null, message: line, fields: {}, request: null, routine: false };
  }
  const { time, level, msg, ...rest } = fields;
  const request = parseApiRequest(msg);
  const parsedLevel = level ? (LEVELS[level.toLowerCase()] ?? null) : null;
  return {
    time: isoOrNull(time),
    level: parsedLevel,
    message: msg,
    fields: rest,
    request,
    routine: request !== null && request.status < 400 && (parsedLevel === 'info' || parsedLevel === 'debug'),
  };
}
