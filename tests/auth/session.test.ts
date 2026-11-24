import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type SessionModule = typeof import('@/lib/session');
type SecretsModule = typeof import('@/lib/secrets');
let session: SessionModule;
let secrets: SecretsModule;
let dataDir: string;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hapm-session-'));
  process.env.HAPM_DATA_DIR = dataDir;
  secrets = await import('@/lib/secrets');
  session = await import('@/lib/session');
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.HAPM_DATA_DIR;
});

describe('CSRF-Token', () => {
  it('hängt an der Sitzung und ist je Sitzung verschieden', () => {
    expect(session.csrfFor('sitzung-1')).toBe(session.csrfFor('sitzung-1'));
    expect(session.csrfFor('sitzung-1')).not.toBe(session.csrfFor('sitzung-2'));
    expect(session.csrfFor('sitzung-1')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('ist nicht die Signatur, mit der Better-Auth seinen Cookie unterschreibt', () => {
    // Better-Auth: HMAC-SHA256 über das nackte Token, mit demselben Geheimnis.
    const cookieSignature = createHmac('sha256', secrets.secrets().sessionSecret).update('sitzung-1').digest();
    expect(session.csrfFor('sitzung-1')).not.toBe(cookieSignature.toString('base64url'));
  });
});
