import { describe, it, expect } from 'vitest';
import { errorTone, liveStats, LIVE_STALE_MS } from '@/lib/haproxy/stats-live';
import type { HaproxyMetric } from '@/lib/types';

/**
 * Die Live-Kennzahlen der Übersicht. Geprüft wird, was eine plausible und
 * trotzdem falsche Zahl ergäbe: eine Rate über das falsche Fenster, eine Null
 * statt „unbekannt", eine eingefrorene Zahl nach dem Ende der Erfassung.
 */

const BASE = {
  $id: 'x', $createdAt: '', $updatedAt: '',
  serverId: 's1', scope: 'https', kind: 'frontend', collectedAt: '',
  requests: null, http2xx: null, http3xx: null, http4xx: null, http5xx: null,
  httpOther: null, denied: null, errors: null, retries: null,
  bytesInKb: null, bytesOutKb: null,
  responseMs: null, totalMs: null, queueMs: null,
  sessionsCurrent: null, sessionsMax: null,
} as HaproxyMetric;

const T0 = Date.parse('2026-11-25T12:00:00.000Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

function row(seconds: number, values: Partial<HaproxyMetric>): HaproxyMetric {
  return { ...BASE, collectedAt: at(seconds), ...values };
}

describe('liveStats', () => {
  it('teilt durch den Abstand der Runden, nicht durch eine Minute', () => {
    const rows = [
      row(0, { requests: 600 }),
      // Der Takt wandert: 90 Sekunden seit der vorigen Runde.
      row(90, { requests: 900, bytesOutKb: 90, bytesInKb: 9 }),
    ];
    const live = liveStats(rows, T0 + 100_000);
    expect(live.rounds).toHaveLength(1);
    expect(live.current.requestsPerSec).toBe(10);
    expect(live.current.bytesOutPerSec).toBe(1024);
    expect(live.current.bytesInPerSec).toBeCloseTo(102.4);
  });

  it('summiert die Frontends einer Runde und nimmt die Antwortzeit gewichtet aus den Backends', () => {
    const rows = [
      row(0, { requests: 0 }),
      row(60, { scope: 'http', requests: 60, sessionsCurrent: 3 }),
      row(60, { scope: 'https', requests: 540, sessionsCurrent: 7 }),
      row(60, { kind: 'backend', scope: 'a', requests: 500, responseMs: 40 }),
      row(60, { kind: 'backend', scope: 'b', requests: 0, responseMs: 900 }),
      row(60, { kind: 'backend', scope: 'c', requests: 100, responseMs: 100 }),
    ];
    const live = liveStats(rows, T0 + 61_000);
    expect(live.current.requestsPerSec).toBe(10);
    expect(live.current.sessions).toBe(10);
    // Das Backend ohne Anfragen zählt nicht mit: (500·40 + 100·100) / 600 = 50.
    expect(live.current.responseMs).toBe(50);
  });

  it('lässt ohne Daten alles unbekannt und nicht null', () => {
    const live = liveStats([], T0);
    expect(live.latestAt).toBeNull();
    expect(live.stale).toBe(true);
    expect(Object.values(live.current).every((value) => value === null)).toBe(true);
    expect(live.rounds).toEqual([]);
  });

  it('kennt nach der ersten Runde die Sitzungen, aber noch keine Rate', () => {
    const live = liveStats([row(0, { sessionsCurrent: 4 })], T0 + 5_000);
    expect(live.stale).toBe(false);
    expect(live.current.sessions).toBe(4);
    expect(live.current.requestsPerSec).toBeNull();
    expect(live.current.share5xx).toBeNull();
  });

  it('zeigt nach dem Ende der Erfassung Striche statt der letzten Zahl', () => {
    const rows = [row(0, { requests: 1 }), row(60, { requests: 60, sessionsCurrent: 2 })];
    const live = liveStats(rows, T0 + 60_000 + LIVE_STALE_MS + 1);
    expect(live.stale).toBe(true);
    expect(live.current.requestsPerSec).toBeNull();
    expect(live.current.sessions).toBeNull();
    // Der Verlauf bleibt: er ist Vergangenheit und stimmt.
    expect(live.rounds).toHaveLength(1);
  });

  it('überbrückt eine Runde ohne Differenz (Reload) mit der vorigen', () => {
    const rows = [
      row(0, { requests: 1 }),
      row(60, { requests: 120 }),
      row(120, { requests: null, sessionsCurrent: 5 }),
    ];
    const live = liveStats(rows, T0 + 125_000);
    expect(live.current.requestsPerSec).toBe(2);
    expect(live.rounds.map((round) => round.requestsPerSec)).toEqual([2, null]);
  });

  it('rechnet die Fehlerquote über fünf Minuten und ohne Anfragen gar nicht', () => {
    const rows = [
      row(0, { requests: 0, http5xx: 0, http4xx: 0 }),
      row(60, { requests: 100, http5xx: 1, http4xx: 10 }),
      row(120, { requests: 100, http5xx: 3, http4xx: 0 }),
    ];
    const live = liveStats(rows, T0 + 125_000);
    expect(live.current.share5xx).toBeCloseTo(0.02);
    expect(live.current.share4xx).toBeCloseTo(0.05);

    const idle = liveStats([row(0, { requests: 0 }), row(60, { requests: 0, http5xx: 0 })], T0 + 61_000);
    expect(idle.current.share5xx).toBeNull();
    expect(idle.current.requestsPerSec).toBe(0);
  });

  it('liest im Drilldown nur die Backend-Zeile des Dienstes', () => {
    const rows = [
      row(0, { kind: 'backend', scope: 'a', requests: 0 }),
      row(60, { kind: 'frontend', scope: 'https', requests: 6000 }),
      row(60, { kind: 'backend', scope: 'a', requests: 60, responseMs: 20, sessionsCurrent: 1 }),
      row(60, { kind: 'backend', scope: 'b', requests: 600, responseMs: 300 }),
    ];
    const live = liveStats(rows, T0 + 61_000, 'a');
    expect(live.current.requestsPerSec).toBe(1);
    expect(live.current.responseMs).toBe(20);
    expect(live.current.sessions).toBe(1);
  });

  it('hat keine Rate über eine Lücke von mehr als fünf Minuten', () => {
    const rows = [row(0, { requests: 1 }), row(600, { requests: 600 })];
    const live = liveStats(rows, T0 + 601_000);
    expect(live.rounds[0].requestsPerSec).toBeNull();
  });
});

describe('errorTone', () => {
  it('warnt ab einem Prozent und schlägt ab fünf an', () => {
    expect(errorTone(null)).toBeUndefined();
    expect(errorTone(0.001)).toBeUndefined();
    expect(errorTone(0.01)).toBe('warning');
    expect(errorTone(0.05)).toBe('danger');
  });
});
