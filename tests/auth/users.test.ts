import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEST_DATABASE_URL, announceSkip, createTestSchema, dropTestSchema } from '../helpers/test-database';

/**
 * Konten und Anmeldung gegen ein echtes Postgres: `lib/auth/users.ts` schreibt
 * über die Ebene unter den Endpunkten des Anmeldedienstes, und ob die Anmeldung
 * das Ergebnis annimmt, zeigt erst der Dienst selbst.
 *
 * Die Fälle bauen aufeinander auf und teilen sich die Datenbank.
 */

type UsersModule = typeof import('@/lib/auth/users');
type ConfigModule = typeof import('@/lib/auth/config');

const SCHEMA = `hapm_test_users_${process.pid}`;
const PASSWORD = 'Erstes-Passwort-1';
const NEW_PASSWORD = 'Zweites-Passwort-2';

let users: UsersModule;
let config: ConfigModule;
let dataDir: string;
let firstId: string;

const suite = TEST_DATABASE_URL ? describe : describe.skip;
if (!TEST_DATABASE_URL) announceSkip('tests/auth/users');

async function signIn(email: string, password: string) {
  const instance = await config.auth();
  return instance.api
    .signInEmail({ body: { email, password }, returnHeaders: true })
    .catch(() => null);
}

/** Aus den `Set-Cookie`-Zeilen einer Antwort die Kopfzeile, die ein Browser zurückschickt. */
function cookieHeader(from: Headers): Headers {
  const pairs = from.getSetCookie().map((line) => line.split(';')[0]);
  return new Headers({ cookie: pairs.join('; ') });
}

suite('Konten', () => {
  beforeAll(async () => {
    // `secrets()` legt seine Datei im Datenverzeichnis an.
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hapm-users-'));
    process.env.HAPM_DATA_DIR = dataDir;
    await createTestSchema(SCHEMA);

    const { ensureAuthTables } = await import('@/lib/db/auth-tables');
    await ensureAuthTables();
    users = await import('@/lib/auth/users');
    config = await import('@/lib/auth/config');
  });

  afterAll(async () => {
    config.resetAuth();
    const { closeDatabase } = await import('@/lib/db/postgres-driver');
    await closeDatabase();
    await dropTestSchema(SCHEMA);
    fs.rmSync(dataDir, { recursive: true, force: true });
    delete process.env.HAPM_DATA_DIR;
  });

  it('legt ein Konto an', async () => {
    expect(await users.countUsers()).toBe(0);

    const user = await users.createUser({ email: '  Anna@Example.com ', name: ' Anna ', password: PASSWORD });
    firstId = user.$id;

    expect(user.email).toBe('anna@example.com');
    expect(user.name).toBe('Anna');
    expect(user.totpEnabled).toBe(false);
    expect(user.passkeyCount).toBe(0);
    expect(user.lastLoginAt).toBeNull();
    expect(new Date(user.$createdAt).toISOString()).toBe(user.$createdAt);
    expect(JSON.stringify(user)).not.toContain(PASSWORD);
    expect(Object.keys(user).sort()).toEqual(
      ['$createdAt', '$id', 'email', 'lastLoginAt', 'name', 'passkeyCount', 'totpEnabled'].sort()
    );
    expect(await users.countUsers()).toBe(1);
  });

  it('lehnt ungültige Angaben ab', async () => {
    await expect(users.createUser({ email: 'keine-adresse', name: 'X', password: PASSWORD })).rejects.toThrow(
      /E-Mail-Adresse/
    );
    await expect(users.createUser({ email: 'b@example.com', name: '  ', password: PASSWORD })).rejects.toThrow(
      /Name/
    );
    await expect(users.createUser({ email: 'b@example.com', name: 'B', password: 'zukurz' })).rejects.toThrow(
      /Passwort/
    );
    expect(await users.countUsers()).toBe(1);
  });

  it('lehnt eine doppelte Adresse ab, auch in anderer Schreibweise', async () => {
    await expect(
      users.createUser({ email: 'ANNA@example.com', name: 'Zweite Anna', password: PASSWORD })
    ).rejects.toMatchObject({ status: 409 });
    expect(await users.countUsers()).toBe(1);
  });

  it('lehnt eine schon vergebene Kennung ab, wie bei zwei gleichzeitigen Ersteinrichtungen', async () => {
    await expect(
      users.createUser({ id: firstId, email: 'zweite@example.com', name: 'Zweite', password: PASSWORD })
    ).rejects.toMatchObject({ status: 409 });
    expect(await users.findUserByEmail('zweite@example.com')).toBeNull();
    expect(await users.countUsers()).toBe(1);
  });

  it('meldet über den Anmeldedienst an, mit einem Hash, den er selbst geschrieben hat', async () => {
    expect(await signIn('anna@example.com', 'Falsches-Passwort-1')).toBeNull();
    expect(await signIn('niemand@example.com', PASSWORD)).toBeNull();

    const result = await signIn('Anna@Example.com', PASSWORD);
    expect(result?.response.user.id).toBe(firstId);
    expect(result?.response.token).toBeTruthy();

    // Ohne HTTPS trägt der Cookie weder `Secure` noch die Vorsilbe dazu: sonst
    // nähme ihn der Browser über http://<adresse>:7080 nicht an.
    const cookies = result!.headers.getSetCookie();
    expect(cookies.some((line) => line.startsWith('better-auth.session_token='))).toBe(true);
    expect(cookies.some((line) => /;\s*secure/i.test(line))).toBe(false);

    const session = await (await config.auth()).api.getSession({ headers: cookieHeader(result!.headers) });
    expect(session?.user.email).toBe('anna@example.com');
    expect(session?.session.token).toBe(result!.response.token);
  });

  it('prüft das Passwort eines Kontos', async () => {
    expect(await users.verifyPassword(firstId, PASSWORD)).toBe(true);
    expect(await users.verifyPassword(firstId, 'Falsches-Passwort-1')).toBe(false);
    expect(await users.verifyPassword('gibt-es-nicht', PASSWORD)).toBe(false);
  });

  it('ändert das Passwort nur mit dem aktuellen', async () => {
    await expect(users.changePassword(firstId, 'Falsches-Passwort-1', NEW_PASSWORD)).rejects.toThrow(
      /aktuelle Passwort/
    );
    await expect(users.changePassword(firstId, PASSWORD, 'zukurz')).rejects.toThrow(/Passwort/);
    expect(await signIn('anna@example.com', PASSWORD)).not.toBeNull();

    await users.changePassword(firstId, PASSWORD, NEW_PASSWORD);

    expect(await signIn('anna@example.com', PASSWORD)).toBeNull();
    expect(await signIn('anna@example.com', NEW_PASSWORD)).not.toBeNull();
  });

  it('vermerkt die letzte Anmeldung und den zweiten Faktor in der Liste', async () => {
    await users.recordLogin(firstId);
    await users.recordLogin(firstId);

    const twoFactor = await import('@/lib/two-factor');
    await twoFactor.store2FASecret(firstId, 'JBSWY3DPEHPK3PXP');
    expect((await users.getUser(firstId))?.totpEnabled).toBe(false);
    await twoFactor.enable2FA((await twoFactor.get2FAConfig(firstId))!);
    expect(await twoFactor.get2FASecret(firstId)).toBe('JBSWY3DPEHPK3PXP');

    const [listed] = await users.listUsers();
    expect(listed.$id).toBe(firstId);
    expect(listed.totpEnabled).toBe(true);
    expect(listed.lastLoginAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(await twoFactor.remove2FA(firstId)).toBe(true);
    expect(await twoFactor.has2FAEnabled(firstId)).toBe(false);
  });

  it('löscht weder das letzte noch das eigene Konto', async () => {
    await expect(users.deleteUser(firstId, 'jemand-anderes')).rejects.toThrow(/letzte Konto/);

    const second = await users.createUser({ email: 'bert@example.com', name: 'Bert', password: PASSWORD });
    await expect(users.deleteUser(firstId, firstId)).rejects.toThrow(/eigene Konto/);
    expect(await users.countUsers()).toBe(2);

    // Wer gelöscht wird, ist sofort draußen: seine Sitzung gilt nicht mehr.
    const session = await signIn('bert@example.com', PASSWORD);
    const twoFactor = await import('@/lib/two-factor');
    await twoFactor.store2FASecret(second.$id, 'JBSWY3DPEHPK3PXP');
    await users.recordLogin(second.$id);

    await users.deleteUser(second.$id, firstId);

    expect((await users.listUsers()).map((user) => user.email)).toEqual(['anna@example.com']);
    expect(await (await config.auth()).api.getSession({ headers: cookieHeader(session!.headers) })).toBeNull();
    expect(await twoFactor.get2FAConfig(second.$id)).toBeNull();
    expect(await signIn('bert@example.com', PASSWORD)).toBeNull();
    await expect(users.deleteUser(firstId, 'jemand-anderes')).rejects.toThrow(/letzte Konto/);
  });

  it('hapm-admin setzt ein Passwort, das die Anmeldung annimmt, und räumt das Konto ab', async () => {
    const admin = (...args: string[]) =>
      execFileSync(process.execPath, ['bin/hapm-admin.mjs', ...args], {
        env: process.env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

    const twoFactor = await import('@/lib/two-factor');
    await twoFactor.store2FASecret(firstId, 'JBSWY3DPEHPK3PXP');
    await twoFactor.enable2FA((await twoFactor.get2FAConfig(firstId))!);
    const before = await signIn('anna@example.com', NEW_PASSWORD);
    expect(before).not.toBeNull();

    expect(admin('users')).toContain('anna@example.com  Anna  zweiter Faktor: ja  Passkeys: 0');

    const output = admin('reset-password', ' Anna@Example.com ');
    const password = /^ {2}(\S+)$/m.exec(output)?.[1];
    expect(password).toBeTruthy();

    expect(await signIn('anna@example.com', NEW_PASSWORD)).toBeNull();
    expect(await signIn('anna@example.com', password!)).not.toBeNull();
    expect(await twoFactor.has2FAEnabled(firstId)).toBe(false);
    // Die Sitzung von vorher ist beendet.
    expect(await (await config.auth()).api.getSession({ headers: cookieHeader(before!.headers) })).toBeNull();

    expect(() => admin('reset-password', 'niemand@example.com')).toThrow(/Kein Konto/);
  });

  it('räumt abgelaufene Sitzungen ab und lässt gültige stehen', async () => {
    const { sql } = await import('@/lib/db/postgres-driver');
    const { pruneAuthTables } = await import('@/lib/db/auth-tables');
    const before = await sql()<{ count: number }[]>`select count(*)::int as count from auth_sessions`;
    expect(before[0].count).toBeGreaterThan(0);

    expect(await pruneAuthTables()).toBe(0);
    await sql()`update auth_sessions set expires_at = now() - interval '1 minute'`;
    expect(await pruneAuthTables()).toBe(before[0].count);
  });
});
