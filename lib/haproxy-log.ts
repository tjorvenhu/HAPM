/**
 * Das Log von HAProxy als Datei.
 *
 * HAProxy schreibt im Container auf stdout, also in das Log von Docker. Die
 * Auswertung unter „Statistik" (`lib/haproxy/access-log.ts`) liest aber eine
 * Datei: sie rechnet mit `tail` und `awk` über bis zu zwei Millionen Zeilen.
 * Dieser Mitschnitt folgt dem Log des Containers und schreibt es nach
 * `/var/log/haproxy/haproxy.log`, einen der Orte, an denen die Auswertung sucht.
 *
 * Nach einem Neustart von HAPM geht es dort weiter, wo die Datei aufhört: Docker
 * hebt das Log auf, und jede Zeile trägt ihren Zeitstempel. Es geht also nichts
 * verloren, solange HAPM kürzer aus ist, als Docker Log aufbewahrt.
 */

import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { engine, haproxyContainerName } from './docker';

export const HAPROXY_LOG_FILE = '/var/log/haproxy/haproxy.log';
const STATE_FILE = '/var/log/haproxy/.hapm-position';

/** Ab dieser Größe wird die Datei beiseitegelegt. Eine Vorgängerin bleibt liegen. */
const ROTATE_BYTES = 256 * 1024 * 1024;
const RETRY_MS = 5000;

interface FollowerState {
  started: boolean;
  /** Zeitstempel der letzten geschriebenen Zeile, wie Docker ihn liefert. */
  last: string;
  connected: boolean;
  lines: number;
}

const globalState = globalThis as unknown as { __hapmLogFollower?: FollowerState };

function state(): FollowerState {
  return (globalState.__hapmLogFollower ??= { started: false, last: '', connected: false, lines: 0 });
}

export function logFollowerStatus(): {
  started: boolean;
  connected: boolean;
  lines: number;
  last: string | null;
} {
  const s = state();
  return { started: s.started, connected: s.connected, lines: s.lines, last: s.last || null };
}

function rotateIfNeeded(): void {
  try {
    if (fs.statSync(HAPROXY_LOG_FILE).size < ROTATE_BYTES) return;
    fs.renameSync(HAPROXY_LOG_FILE, `${HAPROXY_LOG_FILE}.1`);
  } catch {
    // Die Datei gibt es noch nicht.
  }
}

/**
 * Eine Zeile aus Docker: `2026-11-24T14:00:00.123456789Z <text>`.
 * Geschrieben wird sie mit einem Kopf wie von syslog, das ist die Form, die
 * die Auswertung kennt.
 */
export function formatLogLine(raw: string): { stamp: string; line: string } | null {
  const space = raw.indexOf(' ');
  if (space === -1) return null;
  const stamp = raw.slice(0, space);
  const text = raw.slice(space + 1).trimEnd();
  if (!/^\d{4}-\d{2}-\d{2}T/.test(stamp) || text === '') return null;
  return { stamp, line: `${stamp.slice(0, 19)}Z haproxy: ${text}` };
}

async function followOnce(): Promise<void> {
  const s = state();
  const sinceSeconds = s.last ? Math.floor(Date.parse(s.last) / 1000) : Math.floor(Date.now() / 1000);

  const res: IncomingMessage = await engine.stream('GET', `/containers/${haproxyContainerName()}/logs`, {
    query: { follow: true, stdout: true, stderr: true, timestamps: true, since: sinceSeconds },
  });
  if ((res.statusCode ?? 0) >= 400) {
    res.resume();
    throw new Error(`Docker antwortet mit ${res.statusCode}`);
  }

  s.connected = true;
  let pending = '';
  let batch: string[] = [];

  const flush = () => {
    if (batch.length === 0) return;
    rotateIfNeeded();
    fs.appendFileSync(HAPROXY_LOG_FILE, batch.join('\n') + '\n');
    s.lines += batch.length;
    batch = [];
    fs.writeFile(STATE_FILE, s.last, () => undefined);
  };

  const feed = engine.demuxer((_channel: 1 | 2, chunk: Buffer) => {
    pending += chunk.toString('utf8');
    let index;
    while ((index = pending.indexOf('\n')) !== -1) {
      const parsed = formatLogLine(pending.slice(0, index));
      pending = pending.slice(index + 1);
      // `since` zählt in Sekunden: was in der Sekunde des Abbruchs schon
      // geschrieben wurde, kommt noch einmal und wird hier übersprungen.
      if (!parsed || parsed.stamp <= s.last) continue;
      s.last = parsed.stamp;
      batch.push(parsed.line);
    }
    flush();
  });

  await new Promise<void>((resolve, reject) => {
    res.on('data', feed);
    res.on('end', resolve);
    res.on('error', reject);
  });
}

export function startLogFollower(): void {
  const s = state();
  if (s.started || process.platform !== 'linux') return;
  s.started = true;

  try {
    s.last = fs.readFileSync(STATE_FILE, 'utf8').trim();
  } catch {
    s.last = '';
  }

  void (async () => {
    for (;;) {
      try {
        await followOnce();
      } catch {
        // Der Container fehlt oder wird gerade ersetzt. Gleich noch einmal.
      }
      s.connected = false;
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  })();
}
