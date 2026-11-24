import { describe, expect, it } from 'vitest';
import { advanceStreaks, type Observed, type Streak } from '@/lib/notifications/streaks';

const T1 = '2026-11-24T12:00:00.000Z';
const T2 = '2026-11-24T12:02:00.000Z';
const T3 = '2026-11-24T12:04:00.000Z';
const T4 = '2026-11-24T12:06:00.000Z';

function rounds(...observed: [string, Record<string, Observed>][]) {
  let streaks: ReadonlyMap<string, Streak> = new Map();
  const steps = [];
  for (const [now, states] of observed) {
    const step = advanceStreaks(streaks, new Map(Object.entries(states)), now);
    streaks = step.streaks;
    steps.push(step);
  }
  return steps;
}

describe('advanceStreaks', () => {
  it('meldet einen Ausfall erst bei der zweiten Prüfung in Folge', () => {
    const [first, second] = rounds([T1, { shop: 'down' }], [T2, { shop: 'down' }]);
    expect(first.down).toEqual([]);
    expect(second.down).toEqual([{ id: 'shop', since: T1 }]);
  });

  it('löst bei einem einzelnen Aussetzer nichts aus', () => {
    const steps = rounds([T1, { shop: 'up' }], [T2, { shop: 'down' }], [T3, { shop: 'up' }], [T4, { shop: 'up' }]);
    expect(steps.flatMap((step) => step.down)).toEqual([]);
  });

  it('nennt einen anhaltenden Ausfall jede Runde wieder, mit dem ersten Zeitpunkt', () => {
    const steps = rounds([T1, { shop: 'down' }], [T2, { shop: 'down' }], [T3, { shop: 'down' }]);
    expect(steps[2].down).toEqual([{ id: 'shop', since: T1 }]);
  });

  it('meldet die Rückkehr genau einmal, bei der zweiten Prüfung in Folge', () => {
    const steps = rounds(
      [T1, { shop: 'down' }],
      [T2, { shop: 'down' }],
      [T3, { shop: 'up' }],
      [T4, { shop: 'up' }],
      ['2026-11-24T12:08:00.000Z', { shop: 'up' }]
    );
    expect(steps.map((step) => step.recovered)).toEqual([[], [], [], ['shop'], []]);
  });

  it('fängt von vorn an, wenn über einen Eintrag eine Runde lang nichts bekannt war', () => {
    const steps = rounds([T1, { shop: 'down' }], [T2, {}], [T3, { shop: 'down' }], [T4, { shop: 'down' }]);
    expect(steps[2].down).toEqual([]);
    expect(steps[3].down).toEqual([{ id: 'shop', since: T3 }]);
  });

  it('hält Einträge auseinander', () => {
    const [, second] = rounds([T1, { shop: 'down', blog: 'up' }], [T2, { shop: 'down', blog: 'up' }]);
    expect(second.down.map((entry) => entry.id)).toEqual(['shop']);
    expect(second.recovered).toEqual(['blog']);
  });
});
