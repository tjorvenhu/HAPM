import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as OTPAuth from 'otpauth';

/**
 * Zwei Dinge, die eine Anmeldung gegen Raten und Mitlesen härten:
 *
 * - ein Code aus der App gilt einmal (`matchTOTPStep`, `totpStepIsFresh`),
 * - Fehlversuche je Konto haben eine Grenze am Tag (`failuresBlocked`), an die
 *   eine richtige Anmeldung nie stößt.
 */

type RateLimit = typeof import('@/lib/rate-limit');
type Totp = typeof import('@/lib/totp');
type TwoFactor = typeof import('@/lib/two-factor');
let limits: RateLimit;
let totp: Totp;
let twoFactor: TwoFactor;
let dataDir: string;

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 10, 26, 12, 0, 0);

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hapm-limits-'));
  process.env.HAPM_DATA_DIR = dataDir;
  limits = await import('@/lib/rate-limit');
  totp = await import('@/lib/totp');
  twoFactor = await import('@/lib/two-factor');
  // Der Import zieht den Anmeldedienst mit: unter der Last der ganzen Suite dauert er länger als zehn Sekunden.
}, 60_000);

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.HAPM_DATA_DIR;
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Fehlversuche je Konto', () => {
  it('sperrt nach der Grenze und gibt nach dem Fenster wieder frei', () => {
    const key = 'test-failures:a';
    for (let i = 0; i < 3; i++) {
      expect(limits.failuresBlocked(key, 3, DAY).blocked).toBe(false);
      limits.recordFailure(key);
      vi.advanceTimersByTime(60_000);
    }
    const blocked = limits.failuresBlocked(key, 3, DAY);
    expect(blocked.blocked).toBe(true);
    // Frei wird es, wenn der älteste der drei aus dem Fenster fällt.
    expect(blocked.retryAfter).toBe(DAY / 1000 - 180);

    vi.advanceTimersByTime(DAY - 180_000 - 1000);
    expect(limits.failuresBlocked(key, 3, DAY).blocked).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(limits.failuresBlocked(key, 3, DAY).blocked).toBe(false);
  });

  it('zählt nur, was eingetragen wird: Nachfragen allein sperrt nie', () => {
    const key = 'test-failures:b';
    for (let i = 0; i < 50; i++) expect(limits.failuresBlocked(key, 3, DAY).blocked).toBe(false);
  });

  it('ein Erfolg leert den Zähler, und Konten zählen getrennt', () => {
    limits.recordFailure('test-failures:c');
    limits.recordFailure('test-failures:c');
    expect(limits.failuresBlocked('test-failures:c', 2, DAY).blocked).toBe(true);
    expect(limits.failuresBlocked('test-failures:d', 2, DAY).blocked).toBe(false);
    limits.clearFailures('test-failures:c');
    expect(limits.failuresBlocked('test-failures:c', 2, DAY).blocked).toBe(false);
  });

  it('hält die Liste klein, auch wenn jemand tausendmal rät', () => {
    const key = 'test-failures:e';
    for (let i = 0; i < 1000; i++) limits.recordFailure(key);
    expect(limits.failuresBlocked(key, 30, DAY).blocked).toBe(true);
    vi.advanceTimersByTime(DAY + 1000);
    expect(limits.failuresBlocked(key, 30, DAY).blocked).toBe(false);
  });
});

describe('ein Code aus der App gilt einmal', () => {
  const secret = new OTPAuth.Secret({ size: 20 });
  const codeAt = (at: number) =>
    new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret }).generate({ timestamp: at });

  it('nennt den Schritt des Codes, auch für den davor und den danach', () => {
    const step = Math.floor(START / 30_000);
    expect(totp.matchTOTPStep(secret.base32, codeAt(START), START)).toBe(step);
    expect(totp.matchTOTPStep(secret.base32, codeAt(START - 30_000), START)).toBe(step - 1);
    expect(totp.matchTOTPStep(secret.base32, codeAt(START + 30_000), START)).toBe(step + 1);
    expect(totp.matchTOTPStep(secret.base32, codeAt(START - 90_000), START)).toBeNull();
    expect(totp.verifyTOTPCode(secret.base32, codeAt(START))).toBe(true);
  });

  it('nimmt nach einem Code nur einen neueren an', () => {
    const step = Math.floor(START / 30_000);
    // Noch nie einer gezeigt (auch Konten aus der Zeit vor dem Feld).
    expect(twoFactor.totpStepIsFresh(step, null)).toBe(true);
    expect(twoFactor.totpStepIsFresh(step, undefined)).toBe(true);
    // Derselbe Code noch einmal, und der ältere, der mit der Toleranz noch stimmte.
    expect(twoFactor.totpStepIsFresh(step, step)).toBe(false);
    expect(twoFactor.totpStepIsFresh(step - 1, step)).toBe(false);
    expect(twoFactor.totpStepIsFresh(step + 1, step)).toBe(true);
  });
});
