import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEST_DATABASE_URL, announceSkip, createTestSchema, dropTestSchema } from '../helpers/test-database';

/**
 * Wiederherstellungscodes: erzeugen und hashen ohne Datenbank, ablegen,
 * einlösen und ersetzen gegen ein echtes Postgres (`lib/two-factor.ts`).
 */

type Codes = typeof import('@/lib/recovery-codes');
type TwoFactor = typeof import('@/lib/two-factor');
let codes: Codes;
let dataDir: string;

beforeAll(async () => {
  // Der Schlüssel des HMAC kommt aus `secrets()`, und die legen ihre Datei im Datenverzeichnis an.
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hapm-recovery-'));
  process.env.HAPM_DATA_DIR = dataDir;
  codes = await import('@/lib/recovery-codes');
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.HAPM_DATA_DIR;
});

describe('Wiederherstellungscodes erzeugen und prüfen', () => {
  it('erzeugt zehn verschiedene Codes in der Form xxxxx-xxxxx', () => {
    const fresh = codes.generateRecoveryCodes();
    expect(fresh).toHaveLength(10);
    expect(new Set(fresh).size).toBe(10);
    for (const code of fresh) expect(code).toMatch(/^[a-z0-9]{5}-[a-z0-9]{5}$/);
    // Keine Zeichen, die man auf Papier verwechselt.
    expect(fresh.join('')).not.toMatch(/[01oli]/);
  });

  it('legt keinen Klartext im Hash ab, und gleiche Codes geben gleiche Hashes', () => {
    const [code] = codes.generateRecoveryCodes(1);
    const hash = codes.hashRecoveryCode(code);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(code.replace('-', ''));
    expect(codes.hashRecoveryCode(code)).toBe(hash);
    expect(codes.hashRecoveryCode(codes.generateRecoveryCodes(1)[0])).not.toBe(hash);
  });

  it('findet einen Code unabhängig von Bindestrich, Leerzeichen und Großschreibung', () => {
    const fresh = codes.generateRecoveryCodes();
    const hashes = fresh.map(codes.hashRecoveryCode);
    const third = fresh[2];
    expect(codes.findRecoveryCode(hashes, third)).toBe(2);
    expect(codes.findRecoveryCode(hashes, third.replace('-', ''))).toBe(2);
    expect(codes.findRecoveryCode(hashes, ` ${third.toUpperCase().replace('-', ' - ')} `)).toBe(2);
  });

  it('lehnt falsche und unmögliche Eingaben ab, ohne zu werfen', () => {
    const hashes = codes.generateRecoveryCodes().map(codes.hashRecoveryCode);
    expect(codes.findRecoveryCode(hashes, 'aaaaa-aaaaa')).toBe(-1);
    expect(codes.findRecoveryCode(hashes, '')).toBe(-1);
    expect(codes.findRecoveryCode(hashes, '123456')).toBe(-1);
    expect(codes.findRecoveryCode(hashes, 'abcde-12345-x')).toBe(-1);
    expect(codes.findRecoveryCode([], 'abcde-12345')).toBe(-1);
    expect(codes.findRecoveryCode(['kein-hash'], 'abcde-12345')).toBe(-1);
    expect(codes.normaliseRecoveryCode('äbcde-12345')).toBeNull();
    expect(() => codes.hashRecoveryCode('zu-kurz')).toThrow();
  });
});

const suite = TEST_DATABASE_URL ? describe : describe.skip;
if (!TEST_DATABASE_URL) announceSkip('tests/auth/recovery-codes');

suite('Wiederherstellungscodes ablegen und einlösen', () => {
  const SCHEMA = `hapm_test_recovery_${process.pid}`;
  const USER = 'konto-recovery';
  let twoFactor: TwoFactor;

  beforeAll(async () => {
    await createTestSchema(SCHEMA);
    twoFactor = await import('@/lib/two-factor');
  });

  afterAll(async () => {
    const { closeDatabase } = await import('@/lib/db/postgres-driver');
    await closeDatabase();
    await dropTestSchema(SCHEMA);
  });

  let issued: string[];

  it('hat vor dem Einschalten keine Codes', async () => {
    await twoFactor.store2FASecret(USER, 'JBSWY3DPEHPK3PXP');
    const config = await twoFactor.get2FAConfig(USER);
    expect(twoFactor.recoveryCodesLeft(config)).toBe(0);
    expect(await twoFactor.consumeRecoveryCode(USER, 'abcde-12345')).toBeNull();
    expect(await twoFactor.replaceRecoveryCodes(USER)).toBeNull();
  });

  it('erzeugt beim Einschalten zehn Codes und legt nur Hashes ab', async () => {
    const config = await twoFactor.get2FAConfig(USER);
    issued = await twoFactor.enable2FA(config!);
    expect(issued).toHaveLength(10);

    const stored = await twoFactor.get2FAConfig(USER);
    expect(stored?.enabled).toBe(true);
    expect(stored?.recoveryCodes).toHaveLength(10);
    expect(stored?.recoveryCodesCreatedAt).toBeTruthy();
    const raw = JSON.stringify(stored);
    for (const code of issued) {
      expect(raw).not.toContain(code);
      expect(raw).not.toContain(code.replace('-', ''));
    }
    expect(twoFactor.recoveryCodesLeft(stored)).toBe(10);
  });

  it('löst einen Code genau einmal ein', async () => {
    expect(await twoFactor.consumeRecoveryCode(USER, issued[0])).toEqual({ remaining: 9 });
    expect(await twoFactor.consumeRecoveryCode(USER, issued[0])).toBeNull();
    expect(await twoFactor.consumeRecoveryCode(USER, 'aaaaa-aaaaa')).toBeNull();
    expect(twoFactor.recoveryCodesLeft(await twoFactor.get2FAConfig(USER))).toBe(9);
  });

  it('lässt denselben Code bei gleichzeitigen Versuchen nur einmal durch', async () => {
    const results = await Promise.all([
      twoFactor.consumeRecoveryCode(USER, issued[1]),
      twoFactor.consumeRecoveryCode(USER, issued[1]),
      twoFactor.consumeRecoveryCode(USER, issued[1]),
    ]);
    expect(results.filter(Boolean)).toEqual([{ remaining: 8 }]);
  });

  it('macht beim Ersetzen die alten Codes ungültig', async () => {
    const renewed = await twoFactor.replaceRecoveryCodes(USER);
    expect(renewed).toHaveLength(10);
    expect(twoFactor.recoveryCodesLeft(await twoFactor.get2FAConfig(USER))).toBe(10);
    expect(await twoFactor.consumeRecoveryCode(USER, issued[2])).toBeNull();
    expect(await twoFactor.consumeRecoveryCode(USER, renewed![0])).toEqual({ remaining: 9 });
  });

  it('gilt nach dem Abschalten nicht mehr', async () => {
    const renewed = await twoFactor.replaceRecoveryCodes(USER);
    await twoFactor.remove2FA(USER);
    expect(await twoFactor.consumeRecoveryCode(USER, renewed![0])).toBeNull();
  });
});
