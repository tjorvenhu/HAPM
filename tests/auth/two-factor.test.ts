import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Der Nachweis des zweiten Faktors: ein signierter Wert, der für ein Konto,
 * eine Sitzung und eine Frist gilt. Ohne Datenbank, die Funktionen sind rein.
 */

type TwoFactor = typeof import('@/lib/two-factor');
let twoFactor: TwoFactor;
let dataDir: string;

const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  // Der Schlüssel der Signatur kommt aus `secrets()`, und die legen ihre Datei im Datenverzeichnis an.
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hapm-2fa-'));
  process.env.HAPM_DATA_DIR = dataDir;
  twoFactor = await import('@/lib/two-factor');
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.HAPM_DATA_DIR;
});

describe('Nachweis des zweiten Faktors', () => {
  it('gilt für das Konto und die Sitzung, für die er ausgestellt wurde', () => {
    const token = twoFactor.sign2FAToken('konto-a', 'sitzung-1');
    expect(twoFactor.verify2FAToken(token, 'konto-a', 'sitzung-1')).toBe(true);
  });

  it('gilt nicht für ein anderes Konto', () => {
    const token = twoFactor.sign2FAToken('konto-a', 'sitzung-1');
    expect(twoFactor.verify2FAToken(token, 'konto-b', 'sitzung-1')).toBe(false);
  });

  it('gilt nicht für eine andere Sitzung desselben Kontos', () => {
    const token = twoFactor.sign2FAToken('konto-a', 'sitzung-1');
    expect(twoFactor.verify2FAToken(token, 'konto-a', 'sitzung-2')).toBe(false);
    expect(twoFactor.verify2FAToken(token, 'konto-a', '')).toBe(false);
  });

  it('verfällt nach 24 Stunden', () => {
    const now = Date.UTC(2026, 0, 1);
    const token = twoFactor.sign2FAToken('konto-a', 'sitzung-1', now);
    expect(twoFactor.verify2FAToken(token, 'konto-a', 'sitzung-1', now + DAY - 1000)).toBe(true);
    expect(twoFactor.verify2FAToken(token, 'konto-a', 'sitzung-1', now + DAY + 1000)).toBe(false);
  });

  it('lässt sich nicht verlängern oder umschreiben', () => {
    const now = Date.UTC(2026, 0, 1);
    const token = twoFactor.sign2FAToken('konto-a', 'sitzung-1', now);
    const [user, , signature] = Buffer.from(token, 'base64url').toString('utf-8').split(':');

    const extended = Buffer.from(`${user}:${now + 30 * DAY}:${signature}`).toString('base64url');
    expect(twoFactor.verify2FAToken(extended, 'konto-a', 'sitzung-1', now + 2 * DAY)).toBe(false);

    const renamed = Buffer.from(`konto-b:${now + DAY}:${signature}`).toString('base64url');
    expect(twoFactor.verify2FAToken(renamed, 'konto-b', 'sitzung-1', now)).toBe(false);
  });

  it('lehnt Unsinn ab, ohne zu werfen', () => {
    expect(twoFactor.verify2FAToken('', 'konto-a', 'sitzung-1')).toBe(false);
    expect(twoFactor.verify2FAToken('kein-token', 'konto-a', 'sitzung-1')).toBe(false);
    expect(twoFactor.verify2FAToken(Buffer.from('a:b').toString('base64url'), 'a', 'sitzung-1')).toBe(false);
  });

  it('trägt das Token der Sitzung nicht im Wert', () => {
    const token = twoFactor.sign2FAToken('konto-a', 'geheimes-sitzungstoken');
    expect(Buffer.from(token, 'base64url').toString('utf-8')).not.toContain('geheimes-sitzungstoken');
  });
});
