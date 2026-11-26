import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as OTPAuth from 'otpauth';
import { TEST_DATABASE_URL, announceSkip, createTestSchema, dropTestSchema } from '../helpers/test-database';

/**
 * Ein Code aus der App meldet genau einmal an (`consumeTOTPCode`), gegen ein
 * echtes Postgres: der Schritt des angenommenen Codes steht in der Zeile des
 * Kontos, und die Schlange je Konto lässt von zwei gleichzeitigen Anmeldungen
 * mit demselben Code nur eine durch.
 */

type TwoFactor = typeof import('@/lib/two-factor');

const SCHEMA = `hapm_test_totp_${process.pid}`;
const USER = 'konto-totp';
const NOW = Date.UTC(2026, 10, 26, 12, 0, 10);
const STEP = 30_000;

let twoFactor: TwoFactor;
let dataDir: string;
const secret = new OTPAuth.Secret({ size: 20 });
const codeAt = (at: number) =>
  new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret }).generate({ timestamp: at });

const suite = TEST_DATABASE_URL ? describe : describe.skip;
if (!TEST_DATABASE_URL) announceSkip('tests/auth/totp-once');

suite('ein Code aus der App meldet einmal an', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hapm-totp-'));
    process.env.HAPM_DATA_DIR = dataDir;
    await createTestSchema(SCHEMA);
    const { ensureCollections } = await import('@/lib/db/postgres-driver');
    await ensureCollections();
    twoFactor = await import('@/lib/two-factor');
  });

  afterAll(async () => {
    const { closeDatabase } = await import('@/lib/db/postgres-driver');
    await closeDatabase();
    await dropTestSchema(SCHEMA);
    fs.rmSync(dataDir, { recursive: true, force: true });
    delete process.env.HAPM_DATA_DIR;
  });

  it('gilt nicht, solange der zweite Faktor nicht eingeschaltet ist', async () => {
    await twoFactor.store2FASecret(USER, secret.base32);
    expect(await twoFactor.consumeTOTPCode(USER, codeAt(NOW), NOW)).toBe('wrong');
  });

  it('der Code der Einrichtung meldet danach nicht noch an', async () => {
    const config = (await twoFactor.get2FAConfig(USER))!;
    const usedStep = Math.floor(NOW / STEP);
    await twoFactor.enable2FA(config, usedStep);
    expect(await twoFactor.consumeTOTPCode(USER, codeAt(NOW), NOW)).toBe('used');
  });

  it('nimmt den nächsten Code an, und denselben kein zweites Mal', async () => {
    const later = NOW + STEP;
    expect(await twoFactor.consumeTOTPCode(USER, '000000', later)).toBe('wrong');
    expect(await twoFactor.consumeTOTPCode(USER, codeAt(later), later)).toBe('ok');
    expect(await twoFactor.consumeTOTPCode(USER, codeAt(later), later)).toBe('used');
    // Der ältere Code stimmte mit der Toleranz noch, gilt aber auch nicht mehr.
    expect(await twoFactor.consumeTOTPCode(USER, codeAt(NOW), later)).toBe('used');
    expect((await twoFactor.get2FAConfig(USER))?.lastTotpStep).toBe(Math.floor(later / STEP));
  });

  it('lässt von zwei gleichzeitigen Anmeldungen mit demselben Code eine durch', async () => {
    const later = NOW + 3 * STEP;
    const code = codeAt(later);
    const outcomes = await Promise.all([
      twoFactor.consumeTOTPCode(USER, code, later),
      twoFactor.consumeTOTPCode(USER, code, later),
      twoFactor.consumeTOTPCode(USER, code, later),
    ]);
    expect([...outcomes].sort()).toEqual(['ok', 'used', 'used']);
  });

  it('eine neue Einrichtung beginnt ohne gemerkten Schritt', async () => {
    await twoFactor.store2FASecret(USER, secret.base32);
    expect((await twoFactor.get2FAConfig(USER))?.lastTotpStep ?? null).toBeNull();
  });
});
