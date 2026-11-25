import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  clampLines,
  filterEntries,
  isLogFilter,
  parseLogLine,
  parseLogOutput,
  stripPort,
  tailCommand,
  DEFAULT_LOG_LINES,
  FILTER_WINDOW,
  MAX_LINE_CHARS,
  MAX_LOG_LINES,
  type LogEntry,
} from '@/lib/haproxy/log-view';
import { formatLogLine } from '@/lib/haproxy-log';

/**
 * Die Zeilen des HAProxy-Logs, wie die Seite „Reverse-Proxy → Logs" sie zeigt.
 *
 * Die Beispiele sind so geschrieben, wie der Mitschnitt sie in die Datei legt:
 * `formatLogLine` aus `lib/haproxy-log.ts` setzt den Kopf davor. So bricht der
 * Test, wenn einer der beiden sein Format ändert und der andere nicht.
 */

function mirrored(text: string, stamp = '2026-11-24T14:00:00.123456789Z'): string {
  const formatted = formatLogLine(`${stamp} ${text}`);
  if (!formatted) throw new Error('formatLogLine lehnt die Zeile ab');
  return formatted.line;
}

const HTTP =
  '203.0.113.7:54321 [24/Nov/2026:14:00:00.123] https~ kunde_shop/srv1 0/0/1/23/24 200 1500 - - ---- 10/10/0/0/0 0/0 "GET /preise?x=1 HTTP/1.1"';

describe('parseLogLine', () => {
  it('zerlegt eine Anfrage aus option httplog', () => {
    const entry = parseLogLine(mirrored(HTTP));
    expect(entry).toMatchObject({
      kind: 'request',
      time: '2026-11-24T14:00:00Z',
      clientIp: '203.0.113.7',
      frontend: 'https',
      backend: 'kunde_shop',
      server: 'srv1',
      method: 'GET',
      path: '/preise?x=1',
      status: 200,
      durationMs: 24,
      bytes: 1500,
      termination: '----',
    });
    expect(entry?.text).toBe(HTTP);
  });

  it('trennt eine IPv6-Adresse von rechts', () => {
    const entry = parseLogLine(mirrored(HTTP.replace('203.0.113.7:54321', '2001:db8::1:54321')));
    expect(entry).toMatchObject({ kind: 'request', clientIp: '2001:db8::1' });
    expect(stripPort('[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(stripPort('192.0.2.1')).toBe('192.0.2.1');
  });

  it('liest eine Anfrage ohne Server, ohne Antwort und mit Captures', () => {
    const line =
      '198.51.100.4:1234 [24/Nov/2026:14:00:01.000] https~ https/<NOSRV> 0/-1/-1/-1/3 -1 0 - - CR-- 1/1/0/0/0 0/0 {host.example} "<BADREQ>"';
    const entry = parseLogLine(mirrored(line));
    expect(entry).toMatchObject({
      kind: 'request',
      backend: 'https',
      server: null,
      method: null,
      path: '<BADREQ>',
      status: null,
      durationMs: 3,
      termination: 'CR--',
    });
  });

  it('nimmt das + von option logasap von der Dauer', () => {
    const line = HTTP.replace('0/0/1/23/24', '0/0/1/23/+524').replace(' 1500 ', ' +1500 ');
    expect(parseLogLine(mirrored(line))).toMatchObject({ durationMs: 524, bytes: 1500 });
  });

  it('erkennt eine TCP-Verbindung', () => {
    const line = '203.0.113.9:40000 [24/Nov/2026:14:00:02.000] tcp_db tcp_db/srv1 1/0/5012 4321 -- 1/1/0/0/0 0/0';
    expect(parseLogLine(mirrored(line))).toMatchObject({
      kind: 'tcp',
      clientIp: '203.0.113.9',
      frontend: 'tcp_db',
      backend: 'tcp_db',
      server: 'srv1',
      durationMs: 5012,
      bytes: 4321,
      termination: '--',
    });
  });

  it('erkennt einen Verbindungsfehler vor der ersten Anfrage', () => {
    const line = '192.0.2.10:51234 [24/Nov/2026:14:00:03.000] https/1: SSL handshake failure';
    expect(parseLogLine(mirrored(line))).toMatchObject({
      kind: 'connection',
      clientIp: '192.0.2.10',
      frontend: 'https/1',
      message: 'SSL handshake failure',
    });
  });

  it('erkennt Meldungen mit Stufe', () => {
    expect(parseLogLine(mirrored('[NOTICE]   (1) : New worker (8) forked'))).toMatchObject({
      kind: 'system',
      level: 'notice',
      message: 'New worker (8) forked',
    });
    expect(parseLogLine(mirrored('[WARNING]  (8) : config : missing timeouts for proxy x.'))).toMatchObject({
      kind: 'system',
      level: 'warning',
    });
    expect(parseLogLine(mirrored("[ALERT]    (1) : config : parsing [/etc/haproxy/haproxy.cfg:12] : unknown keyword 'foo'."))).toMatchObject({
      kind: 'system',
      level: 'alert',
    });
  });

  it('erkennt Meldungen ohne Stufe am Wortlaut', () => {
    const down = parseLogLine(
      mirrored('Server kunde_shop/srv1 is DOWN, reason: Layer4 connection problem, info: "Connection refused", check duration: 0ms.')
    );
    expect(down).toMatchObject({ kind: 'system', level: 'warning' });
    expect(parseLogLine(mirrored('Server kunde_shop/srv1 is UP, reason: Layer4 check passed.'))).toMatchObject({
      kind: 'system',
      level: 'notice',
    });
    expect(parseLogLine(mirrored('backend kunde_shop has no server available!'))).toMatchObject({
      kind: 'system',
      level: 'alert',
    });
    expect(parseLogLine(mirrored('Proxy https started.'))).toMatchObject({ kind: 'system', level: 'notice' });
  });

  it('gibt eine unbekannte Zeile roh zurück und nicht gar nicht', () => {
    expect(parseLogLine(mirrored('etwas ganz anderes'))).toEqual({
      kind: 'raw',
      time: '2026-11-24T14:00:00Z',
      text: 'etwas ganz anderes',
    });
    // Ohne Kopf, etwa eine Datei von rsyslog ohne Mitschnitt.
    expect(parseLogLine('nur Text')).toEqual({ kind: 'raw', time: null, text: 'nur Text' });
  });

  it('versteht auch den Kopf von rsyslog', () => {
    const entry = parseLogLine(`Feb  6 12:14:14 lb1 haproxy[1234]: ${HTTP}`);
    expect(entry).toMatchObject({ kind: 'request', time: null, status: 200 });
  });

  it('kürzt eine sehr lange Zeile', () => {
    const entry = parseLogLine(mirrored('x'.repeat(MAX_LINE_CHARS + 500)));
    expect(entry?.text.length).toBe(MAX_LINE_CHARS + 1);
  });

  it('überspringt leere Zeilen', () => {
    expect(parseLogLine('')).toBeNull();
    expect(parseLogLine('   \r')).toBeNull();
  });
});

const STATUS_LINES = [200, 301, 404, 503].map((status, i) =>
  mirrored(HTTP.replace(' 200 1500 ', ` ${status} 10 `), `2026-11-24T14:00:0${i}.000Z`)
);

const OUTPUT = [
  mirrored('[NOTICE]   (1) : haproxy version is 3.2.4', '2026-11-24T13:59:00.000Z'),
  ...STATUS_LINES,
  mirrored('[WARNING]  (8) : Server kunde_shop/srv2 is DOWN.', '2026-11-24T14:00:05.000Z'),
  mirrored('kaputt', '2026-11-24T14:00:06.000Z'),
  '',
].join('\n');

function statuses(entries: LogEntry[]): (number | null)[] {
  return entries.map((entry) => (entry.kind === 'request' ? entry.status : null));
}

describe('parseLogOutput und filterEntries', () => {
  const entries = parseLogOutput(OUTPUT);

  it('stellt die neueste Zeile nach oben', () => {
    expect(entries).toHaveLength(7);
    expect(entries[0]).toMatchObject({ kind: 'raw', text: 'kaputt' });
    expect(entries[entries.length - 1]).toMatchObject({ kind: 'system', level: 'notice' });
  });

  it('filtert nach Statusklasse', () => {
    expect(statuses(filterEntries(entries, { filter: '2xx', query: '', limit: 10 }).entries)).toEqual([200]);
    expect(statuses(filterEntries(entries, { filter: '3xx', query: '', limit: 10 }).entries)).toEqual([301]);
    expect(statuses(filterEntries(entries, { filter: '4xx', query: '', limit: 10 }).entries)).toEqual([404]);
    expect(statuses(filterEntries(entries, { filter: '5xx', query: '', limit: 10 }).entries)).toEqual([503]);
    expect(filterEntries(entries, { filter: 'requests', query: '', limit: 10 }).matched).toBe(4);
  });

  it('trennt Meldungen von HAProxy und davon Warnungen und Fehler', () => {
    const system = filterEntries(entries, { filter: 'system', query: '', limit: 10 }).entries;
    expect(system.map((entry) => entry.kind)).toEqual(['raw', 'system', 'system']);
    const problems = filterEntries(entries, { filter: 'problems', query: '', limit: 10 }).entries;
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ level: 'warning' });
  });

  it('sucht ohne Rücksicht auf Groß- und Kleinschreibung und zählt alle Treffer', () => {
    const found = filterEntries(entries, { filter: 'all', query: 'KUNDE_SHOP', limit: 2 });
    expect(found.matched).toBe(5);
    expect(found.entries).toHaveLength(2);
    expect(filterEntries(entries, { filter: '5xx', query: 'preise', limit: 10 }).matched).toBe(1);
    expect(filterEntries(entries, { filter: 'all', query: 'gibt es nicht', limit: 10 }).matched).toBe(0);
  });

  it('kennt nur die eigenen Filter', () => {
    expect(isLogFilter('5xx')).toBe(true);
    expect(isLogFilter('6xx')).toBe(false);
    expect(isLogFilter(undefined)).toBe(false);
  });
});

describe('Grenzen', () => {
  it('klemmt die Zeilenzahl', () => {
    expect(clampLines(null)).toBe(DEFAULT_LOG_LINES);
    expect(clampLines('abc')).toBe(DEFAULT_LOG_LINES);
    expect(clampLines('0')).toBe(DEFAULT_LOG_LINES);
    expect(clampLines('500')).toBe(500);
    expect(clampLines('999999')).toBe(MAX_LOG_LINES);
  });

  it('baut das Kommando aus einem argv und klemmt auch dort', () => {
    expect(tailCommand('/var/log/haproxy/haproxy.log', 200)).toBe(
      "'tail' '-n' '200' '--' '/var/log/haproxy/haproxy.log'"
    );
    expect(tailCommand('/x', 10_000_000)).toContain(`'${FILTER_WINDOW}'`);
    expect(tailCommand('/x', -5)).toContain("'-n' '1'");
  });
});

/**
 * Das Kommando von einer echten Bash gelesen: erst dort zeigt sich, ob ein
 * Pfad mit Leerzeichen oder Anführungszeichen heil ankommt.
 */
describe('tailCommand in einer echten Bash', () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('liest die letzten Zeilen, auch bei einem seltsamen Pfad', () => {
    dir = mkdtempSync(join(tmpdir(), 'hapm-log-'));
    const file = join(dir, "it's a log.log").replace(/\\/g, '/');
    writeFileSync(file, OUTPUT);

    const stdout = execFileSync('bash', ['-c', tailCommand(file, 3)], { encoding: 'utf8' });
    const entries = parseLogOutput(stdout);
    expect(entries.map((entry) => entry.kind)).toEqual(['raw', 'system', 'request']);
  });
});
