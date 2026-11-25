import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  mergeLive,
  prune,
  sameProcess,
  secondStats,
  splitInfoAndStat,
  SECONDS_BUFFER_MS,
  SECONDS_STALE_MS,
  type SecondRow,
  type SecondSample,
} from '@/lib/haproxy/stats-seconds';
import { askStatsSocket } from '@/lib/haproxy/stats-socket';
import { parseProcessInfo, parseStatRows } from '@/lib/haproxy/stats-parse';
import type { LiveCurrent } from '@/lib/haproxy/stats-live';

/**
 * Die Sekundenwerte der Live-Kacheln. Wie bei `liveStats` geht es um Zahlen,
 * die plausibel aussehen und trotzdem falsch sind: eine Rate über das falsche
 * Fenster, eine Differenz über einen Reload hinweg, eine 0 statt „unbekannt".
 */

const T0 = Date.parse('2026-11-25T12:00:00.000Z');

const ROW: SecondRow = {
  scope: 'https',
  kind: 'frontend',
  requests: null,
  http4xx: null,
  http5xx: null,
  bytesIn: null,
  bytesOut: null,
  sessionsCurrent: null,
  responseMs: null,
};

function sample(seconds: number, uptimeSec: number | null, rows: Partial<SecondRow>[]): SecondSample {
  return { at: T0 + seconds * 1000, uptimeSec, rows: rows.map((row) => ({ ...ROW, ...row })) };
}

describe('secondStats', () => {
  it('rechnet über die echten Abstände und höchstens fünf Sekunden zurück', () => {
    const samples = [
      sample(0, 100, [{ requests: 0, bytesOut: 0 }]),
      sample(4, 104, [{ requests: 10, bytesOut: 4096 }]),
      // Der Takt wandert: 1,5 s statt einer.
      sample(5.5, 105, [{ requests: 40, bytesOut: 10_240 }]),
    ];
    const stats = secondStats(samples, T0 + 6_000);
    expect(stats.stale).toBe(false);
    // Basis ist die Probe bei 4 s (die bei 0 liegt 5,5 s zurück): 30 Anfragen in 1,5 s.
    expect(stats.current.requestsPerSec).toBe(20);
    expect(stats.current.bytesOutPerSec).toBe(4096);
  });

  it('kennt nach der ersten Probe nur den Momentanwert', () => {
    const stats = secondStats([sample(0, 100, [{ requests: 7, sessionsCurrent: 3 }])], T0 + 500);
    expect(stats.current.sessions).toBe(3);
    expect(stats.current.requestsPerSec).toBeNull();
  });

  it('eine Sekunde ohne Anfrage ist eine Messung: 0, nicht unbekannt', () => {
    const samples = [sample(0, 100, [{ requests: 50 }]), sample(1, 101, [{ requests: 50 }])];
    expect(secondStats(samples, T0 + 1_000).current.requestsPerSec).toBe(0);
  });

  it('rechnet nicht über einen Reload hinweg, auch wenn der Zähler danach höher steht', () => {
    const samples = [
      sample(0, 500, [{ requests: 10 }]),
      // Nach einer Pause des Samplers: neuer Prozess, läuft schon 200 s, mehr Anfragen als vorher.
      sample(300, 200, [{ requests: 900 }]),
      sample(301, 201, [{ requests: 905 }]),
    ];
    expect(sameProcess(samples[0], samples[1])).toBe(false);
    expect(sameProcess(samples[1], samples[2])).toBe(true);
    const stats = secondStats(samples, T0 + 301_000);
    expect(stats.current.requestsPerSec).toBe(5);
  });

  it('ein Rücksprung ohne bekannte Laufzeit ist unbekannt und keine negative Rate', () => {
    const samples = [sample(0, null, [{ requests: 100 }]), sample(2, null, [{ requests: 5 }])];
    expect(secondStats(samples, T0 + 2_000).current.requestsPerSec).toBeNull();
  });

  it('summiert die Frontends und nimmt die Antwortzeit gewichtet aus den Backends', () => {
    const samples = [
      sample(0, 100, [
        { scope: 'http', requests: 0, sessionsCurrent: 1 },
        { scope: 'https', requests: 0, sessionsCurrent: 1 },
        { kind: 'backend', scope: 'a', requests: 0, responseMs: 40 },
        { kind: 'backend', scope: 'b', requests: 0, responseMs: 900 },
        { kind: 'backend', scope: 'c', requests: 0, responseMs: 100 },
      ]),
      sample(2, 102, [
        { scope: 'http', requests: 4, sessionsCurrent: 2 },
        { scope: 'https', requests: 16, sessionsCurrent: 5 },
        { kind: 'backend', scope: 'a', requests: 15, responseMs: 40 },
        // Ohne Anfragen in der Spanne zählt b nicht, sein Mittel ist alt.
        { kind: 'backend', scope: 'b', requests: 0, responseMs: 900 },
        { kind: 'backend', scope: 'c', requests: 5, responseMs: 100 },
      ]),
    ];
    const stats = secondStats(samples, T0 + 2_000);
    expect(stats.current.requestsPerSec).toBe(10);
    expect(stats.current.sessions).toBe(7);
    expect(stats.current.responseMs).toBe(55);
  });

  it('nimmt im Drilldown nur die Backend-Zeile des Dienstes, nicht das gleichnamige Frontend', () => {
    const samples = [
      sample(0, 100, [
        { kind: 'frontend', scope: 'tcp-5432', requests: 0, sessionsCurrent: 9 },
        { kind: 'backend', scope: 'tcp-5432', requests: 0, sessionsCurrent: 2, responseMs: 0 },
      ]),
      sample(1, 101, [
        { kind: 'frontend', scope: 'tcp-5432', requests: 100, sessionsCurrent: 9 },
        { kind: 'backend', scope: 'tcp-5432', requests: 3, sessionsCurrent: 2, responseMs: 0 },
      ]),
    ];
    const stats = secondStats(samples, T0 + 1_000, 'tcp-5432');
    expect(stats.current.requestsPerSec).toBe(3);
    expect(stats.current.sessions).toBe(2);
  });

  it('gibt die Fehlerquote erst, wenn die Proben das ganze Fenster abdecken', () => {
    const early = [
      sample(0, 100, [{ requests: 0, http5xx: 0, http4xx: 0 }]),
      sample(30, 130, [{ requests: 20, http5xx: 1, http4xx: 0 }]),
    ];
    expect(secondStats(early, T0 + 30_000).current.share5xx).toBeNull();

    const full = [
      sample(0, 100, [{ requests: 0, http5xx: 0, http4xx: 0 }]),
      sample(300, 400, [{ requests: 1000, http5xx: 10, http4xx: 50 }]),
    ];
    const stats = secondStats(full, T0 + 300_000);
    expect(stats.current.share5xx).toBeCloseTo(0.01);
    expect(stats.current.share4xx).toBeCloseTo(0.05);
  });

  it('ohne Anfragen gibt es keine Quote, auch keine von null Prozent', () => {
    const samples = [
      sample(0, 100, [{ requests: 5, http5xx: 0 }]),
      sample(300, 400, [{ requests: 5, http5xx: 0 }]),
    ];
    expect(secondStats(samples, T0 + 300_000).current.share5xx).toBeNull();
  });

  it('eine alte Probe ist nicht „jetzt"', () => {
    const samples = [sample(0, 100, [{ requests: 0 }]), sample(1, 101, [{ requests: 5, sessionsCurrent: 4 }])];
    const stats = secondStats(samples, T0 + 1_000 + SECONDS_STALE_MS + 1);
    expect(stats.stale).toBe(true);
    expect(stats.latestAt).toBe(new Date(T0 + 1_000).toISOString());
    expect(stats.current.sessions).toBeNull();
    expect(secondStats([], T0).latestAt).toBeNull();
  });
});

describe('mergeLive', () => {
  const none: LiveCurrent = {
    requestsPerSec: null,
    bytesInPerSec: null,
    bytesOutPerSec: null,
    responseMs: null,
    sessions: null,
    share5xx: null,
    share4xx: null,
  };

  it('nimmt je Kennzahl den Sekundenwert und fällt sonst auf die Minute zurück', () => {
    const merged = mergeLive(
      { ...none, requestsPerSec: 12, share5xx: 0.02, responseMs: 80 },
      { ...none, requestsPerSec: 0, sessions: 4 }
    );
    expect(merged.requestsPerSec).toBe(0);
    expect(merged.sessions).toBe(4);
    expect(merged.share5xx).toBe(0.02);
    expect(merged.responseMs).toBe(80);
    expect(merged.bytesInPerSec).toBeNull();
    expect(mergeLive(null, null)).toEqual(none);
  });
});

describe('prune', () => {
  it('behält den Puffer und wirft Älteres weg', () => {
    const now = T0 + 2 * SECONDS_BUFFER_MS;
    const samples = [sample(0, 1, []), { ...sample(0, 1, []), at: now - 1_000 }];
    expect(prune(samples, now)).toHaveLength(1);
    const kept = [{ ...sample(0, 1, []), at: now - 1_000 }];
    expect(prune(kept, now)).toBe(kept);
  });
});

const INFO = 'Name: HAProxy\nVersion: 3.0.5\nUptime_sec: 4711\nCurrConns: 3\n\n';
const STAT =
  '# pxname,svname,qcur,scur,smax,stot,bin,bout,hrsp_4xx,hrsp_5xx,req_tot,rtime\n' +
  'https,FRONTEND,,6,9,120,2048,4096,2,1,300,\n' +
  'svc,web1,0,1,2,40,0,0,0,0,,12\n' +
  'svc,BACKEND,0,1,2,40,1024,2048,0,1,40,12\n\n';

describe('splitInfoAndStat', () => {
  it('trennt die Antwort von `show info;show stat` an der Kopfzeile', () => {
    const { info, stat } = splitInfoAndStat(INFO + STAT);
    expect(parseProcessInfo(info).uptimeSec).toBe(4711);
    const rows = parseStatRows(stat);
    expect(rows.map((row) => `${row.kind}:${row.scope}`)).toEqual(['frontend:https', 'backend:svc']);
  });

  it('ohne CSV gibt es keine Zeilen', () => {
    expect(splitInfoAndStat('Unknown command.\n').stat).toBe('');
  });
});

describe('askStatsSocket', () => {
  let server: net.Server | null = null;
  afterEach(() => {
    server?.close();
    server = null;
  });

  // Unter Windows ist ein Pfad für `listen` eine Named Pipe, unter Linux ein Unix-Socket.
  const socketPath = () =>
    process.platform === 'win32'
      ? `\\\\.\\pipe\\hapm-test-${process.pid}-${Math.random().toString(36).slice(2)}`
      : path.join(os.tmpdir(), `hapm-test-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);

  it('schickt das Kommando und liest bis HAProxy die Verbindung schließt', async () => {
    const where = socketPath();
    let received = '';
    server = net.createServer((conn) => {
      conn.on('data', (chunk) => {
        received += chunk.toString();
        // HAProxy ohne `prompt`: antworten, dann schließen. In Stücken, wie bei einer langen CSV.
        conn.write(INFO);
        setTimeout(() => conn.end(STAT), 5);
      });
    });
    await new Promise<void>((resolve) => server!.listen(where, resolve));

    const started = performance.now();
    const answer = await askStatsSocket(where, 'show info;show stat', 2_000);
    const elapsed = performance.now() - started;

    expect(received).toBe('show info;show stat\n');
    expect(answer).toBe(INFO + STAT);
    expect(elapsed).toBeLessThan(1_000);
  });

  it('ein fehlender Socket ist ein Fehler und hängt nicht', async () => {
    await expect(askStatsSocket(socketPath(), 'show stat', 2_000)).rejects.toThrow();
  });

  it('bricht nach der Wartezeit ab, wenn HAProxy nicht antwortet', async () => {
    const where = socketPath();
    server = net.createServer(() => undefined);
    await new Promise<void>((resolve) => server!.listen(where, resolve));
    await expect(askStatsSocket(where, 'show stat', 100)).rejects.toThrow(/Zeitüberschreitung/);
  });
});
