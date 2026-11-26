import { describe, it, expect } from 'vitest';
import { timeReached } from '@/lib/schedule-time';

const at = (y: number, m: number, d: number, h: number, min: number, s = 0) => new Date(y, m - 1, d, h, min, s).getTime();

describe('timeReached', () => {
  it('trifft, wenn die Uhrzeit zwischen zwei Takten liegt, und nur dann', () => {
    expect(timeReached('02:30', at(2026, 11, 26, 2, 29, 30), at(2026, 11, 26, 2, 30, 30))).toBe(true);
    expect(timeReached('02:30', at(2026, 11, 26, 2, 30, 30), at(2026, 11, 26, 2, 31, 30))).toBe(false);
    expect(timeReached('02:30', at(2026, 11, 26, 2, 28, 30), at(2026, 11, 26, 2, 29, 30))).toBe(false);
  });

  it('verliert keine Minute, wenn ein Takt sie überspringt', () => {
    // Der Takt kam bei 02:29:59.9 und wieder bei 02:31:00.0: die Uhr zeigte nie 02:30.
    expect(timeReached('02:30', at(2026, 11, 26, 2, 29, 59), at(2026, 11, 26, 2, 31, 0))).toBe(true);
  });

  it('holt nach einem Neustart nicht nach, was davor lag', () => {
    expect(timeReached('02:30', at(2026, 11, 26, 15, 0), at(2026, 11, 26, 15, 1))).toBe(false);
  });

  it('trifft auch über Mitternacht', () => {
    expect(timeReached('23:59', at(2026, 11, 26, 23, 58, 50), at(2026, 11, 27, 0, 0, 10))).toBe(true);
    expect(timeReached('00:00', at(2026, 11, 26, 23, 59, 30), at(2026, 11, 27, 0, 0, 30))).toBe(true);
  });

  it('läuft am Tag der Umstellung auf Sommerzeit trotzdem einmal', () => {
    // Nur in Zeitzonen, in denen es 02:30 am 28.03.2027 nicht gibt (etwa Europe/Berlin).
    const gap = new Date(2027, 2, 28, 2, 30).getHours() !== 2;
    if (!gap) return;
    let hits = 0;
    for (let t = at(2027, 3, 28, 0, 0); t < at(2027, 3, 28, 6, 0); t += 60_000) {
      if (timeReached('02:30', t, t + 60_000)) hits++;
    }
    expect(hits).toBe(1);
  });

  it('läuft am Tag der Rückstellung nur einmal', () => {
    let hits = 0;
    for (let t = at(2027, 10, 31, 0, 0); t < at(2027, 10, 31, 6, 0); t += 60_000) {
      if (timeReached('02:30', t, t + 60_000)) hits++;
    }
    expect(hits).toBe(1);
  });

  it('nimmt eine unlesbare Uhrzeit nie als erreicht', () => {
    expect(timeReached('abc', 0, Date.now())).toBe(false);
  });
});
