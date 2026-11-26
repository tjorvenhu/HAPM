import { describe, it, expect, vi } from 'vitest';
import {
  addPendingRun,
  applyRunSnapshot,
  isQueued,
  placeholderRuns,
  removePendingRuns,
  runForEntry,
  type PendingRun,
} from '@/components/reverse-proxy/pendingRuns';
// Die Sperre fragt die Rolle des Knotens aus der Datenbank (`tests/sync/guard.test.ts`).
// Hier geht es nur um die Reihenfolge der Vorgänge.
vi.mock('@/lib/sync/role', () => ({ assertProxyWritable: async () => undefined, isReplica: async () => false }));

import { withProxyLock } from '@/lib/haproxy/provision';
import type { HaproxyPhase } from '@/lib/types';

/**
 * Mehrere eigene Vorgänge auf einer Gruppenseite.
 *
 * Der Fehler, den das abdeckt: drei Ziele kurz nacheinander angelegt, oben
 * stand eine Platzhalterkarte, und nur der zuletzt gestartete Lauf bekam seine
 * Meldung. Die Seite hielt einen einzelnen Lauf, jeder Start überschrieb ihn.
 */

function run(id: string, over: Partial<PendingRun> = {}): PendingRun {
  return {
    id,
    label: `Ziel „${id}" anlegen`,
    serviceId: id,
    title: `${id}.example.org`,
    isNew: true,
    kind: 'write',
    phase: null,
    steps: [],
    ...over,
  };
}

describe('eigene Vorgänge einer Gruppenseite', () => {
  it('behält jeden gestarteten Lauf, in der Reihenfolge des Starts', () => {
    let runs: PendingRun[] = [];
    runs = addPendingRun(runs, run('a'));
    runs = addPendingRun(runs, run('b'));
    runs = addPendingRun(runs, run('c'));
    expect(runs.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    // Derselbe Lauf zweimal gemeldet bleibt einer.
    expect(addPendingRun(runs, run('b'))).toBe(runs);
  });

  it('zeigt je laufendem Anlegen eine Platzhalterkarte', () => {
    const runs = [run('a'), run('b'), run('shop', { isNew: false }), run('c')];
    expect(placeholderRuns(runs, new Set()).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('lässt den Platzhalter weg, sobald die ID in der Konfiguration steht', () => {
    const runs = [run('a'), run('b')];
    expect(placeholderRuns(runs, new Set(['a'])).map((r) => r.id)).toEqual(['b']);
    // Die echte Karte trägt dann den Lauf, bis er fertig ist.
    expect(runForEntry(runs, 'a')?.id).toBe('a');
  });

  it('nimmt für eine bestehende Karte den zuerst gestarteten Lauf', () => {
    const runs = [
      run('u1', { serviceId: 'shop', isNew: false }),
      run('d1', { serviceId: 'shop', isNew: false, kind: 'delete' }),
    ];
    expect(runForEntry(runs, 'shop')?.id).toBe('u1');
    expect(runForEntry(runs, 'blog')).toBeNull();
  });

  it('zieht Phase und Schritte nur des gemeinten Laufs nach', () => {
    const runs = [run('a'), run('b')];
    const next = applyRunSnapshot(runs, 'b', {
      status: 'running',
      phase: 'certificate',
      steps: [{ label: 'Zertifikat wird ausgestellt', ok: true, running: true }],
    });
    expect(next[0]).toBe(runs[0]);
    expect(next[1].phase).toBe('Zertifikat');
    expect(next[1].steps).toHaveLength(1);
    // Ohne Änderung dieselbe Liste: kein Render je Poll-Takt.
    expect(
      applyRunSnapshot(next, 'b', {
        status: 'running',
        phase: 'certificate',
        steps: [{ label: 'Zertifikat wird ausgestellt', ok: true, running: true }],
      })
    ).toBe(next);
  });

  it('erkennt einen wartenden Lauf an der Phase queued', () => {
    const [waiting] = applyRunSnapshot([run('a')], 'a', { status: 'running', phase: 'queued' });
    expect(isQueued(waiting)).toBe(true);
    const [started] = applyRunSnapshot([waiting], 'a', { status: 'running', phase: 'preflight' });
    expect(isQueued(started)).toBe(false);
  });

  it('räumt nur die fertigen Läufe ab', () => {
    const runs = [run('a'), run('b'), run('c')];
    expect(removePendingRuns(runs, new Set(['a', 'c'])).map((r) => r.id)).toEqual(['b']);
    expect(removePendingRuns(runs, new Set(['x']))).toBe(runs);
  });
});

describe('Lock des Proxys', () => {
  it('meldet queued nur für einen Vorgang, der hinter einem anderen wartet', async () => {
    const serverId = `test-${Math.random()}`;
    const phases: Record<string, HaproxyPhase[]> = { first: [], second: [], third: [] };
    const order: string[] = [];
    let finishFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });

    const first = withProxyLock(serverId, { onPhase: (p) => void phases.first.push(p) }, async () => {
      order.push('first');
      await firstHeld;
    });
    const second = withProxyLock(serverId, { onPhase: (p) => void phases.second.push(p) }, async () => {
      order.push('second');
    });
    // Die Meldung kommt, bevor der wartende Vorgang dran ist.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(phases.second).toEqual(['queued']);
    expect(order).toEqual(['first']);

    finishFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
    expect(phases.first).toEqual([]);

    // Danach ist der Lock frei: kein Warten mehr.
    await withProxyLock(serverId, { onPhase: (p) => void phases.third.push(p) }, async () => {});
    expect(phases.third).toEqual([]);
  });
});
