import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEST_DATABASE_URL, announceSkip, createTestSchema, dropTestSchema } from '../helpers/test-database';
import type { SyncData } from '@/lib/sync/data';

/**
 * Der Datenteil gegen ein echtes Postgres: einsammeln (`data-collect.ts`) und
 * auf einem Knoten einsetzen, dessen Datenbank anders aussieht
 * (`data-apply.ts`, `lib/db/account-rows.ts`).
 *
 * Beide Rollen spielt dieselbe Datenbank: erst der Stand eines Hauptknotens,
 * dann wird sie zu dem verändert, was ein Folgeknoten vor dem Abgleich hat,
 * und der Stand kommt zurück. Ob die Anmeldung das Ergebnis annimmt, zeigt
 * erst der Anmeldedienst selbst.
 *
 * Die Fälle bauen aufeinander auf und teilen sich die Datenbank.
 */

const SCHEMA = `hapm_test_syncdata_${process.pid}`;
const PASSWORD = 'Erstes-Passwort-1';
const NEW_PASSWORD = 'Zweites-Passwort-2';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
if (!TEST_DATABASE_URL) announceSkip('tests/sync/data-apply');

type Db = typeof import('@/lib/db');
type Driver = typeof import('@/lib/db/postgres-driver');

let db: Db;
let driver: Driver;
let users: typeof import('@/lib/auth/users');
let config: typeof import('@/lib/auth/config');
let collect: typeof import('@/lib/sync/data-collect');
let apply: typeof import('@/lib/sync/data-apply');
let data: typeof import('@/lib/sync/data');
let crypto: typeof import('@/lib/crypto');
let settings: typeof import('@/lib/settings');
let store: typeof import('@/lib/sync/store');
let types: typeof import('@/lib/types');
let dataDir: string;

/** Der Stand des Hauptknotens, wie er im Paket steht. */
let primary: SyncData;
let ada: string;
let ben: string;

async function signIn(email: string, password: string) {
  const instance = await config.auth();
  return instance.api.signInEmail({ body: { email, password }, returnHeaders: true }).catch(() => null);
}

async function sessionsOf(userId: string): Promise<number> {
  const rows = await driver.sql()`select count(*)::int as count from auth_sessions where user_id = ${userId}`;
  return Number(rows[0].count);
}

async function snapshot(): Promise<SyncData> {
  return { ...(await collect.collectDbData()), crowdsec: null };
}

suite('der Datenteil gegen Postgres', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hapm-syncdata-'));
    process.env.HAPM_DATA_DIR = dataDir;
    await createTestSchema(SCHEMA);

    const { ensureAuthTables } = await import('@/lib/db/auth-tables');
    await ensureAuthTables();
    db = await import('@/lib/db');
    driver = await import('@/lib/db/postgres-driver');
    users = await import('@/lib/auth/users');
    config = await import('@/lib/auth/config');
    collect = await import('@/lib/sync/data-collect');
    apply = await import('@/lib/sync/data-apply');
    data = await import('@/lib/sync/data');
    crypto = await import('@/lib/crypto');
    settings = await import('@/lib/settings');
    store = await import('@/lib/sync/store');
    types = await import('@/lib/types');
  });

  afterAll(async () => {
    config.resetAuth();
    await driver.closeDatabase();
    await dropTestSchema(SCHEMA);
    fs.rmSync(dataDir, { recursive: true, force: true });
    delete process.env.HAPM_DATA_DIR;
  });

  it('sammelt ein, was ein Hauptknoten weitergibt, mit lesbaren Geheimnissen', async () => {
    ada = (await users.createUser({ email: 'ada@example.org', name: 'Ada', password: PASSWORD })).$id;
    ben = (await users.createUser({ email: 'ben@example.org', name: 'Ben', password: PASSWORD })).$id;
    const twoFactor = await import('@/lib/two-factor');
    await twoFactor.store2FASecret(ada, TOTP_SECRET);
    await twoFactor.enable2FA((await twoFactor.get2FAConfig(ada))!);
    await driver.sql()`
      insert into auth_passkeys (id, name, public_key, user_id, credential_id, counter, device_type, backed_up, transports, aaguid)
      values ('pk-ada', 'Laptop', 'cHVibGlj', ${ada}, 'cred-ada', 3, 'multiDevice', true, 'internal', null)
    `;
    await settings.updateSettings({
      acmeEmail: 'acme@example.org',
      smtpHost: 'mail.example.org',
      smtpPass: 'smtp-geheim',
      mailFrom: 'hapm@example.org',
      notifyRecipients: ['ops@example.org'],
      exposure: 'internal',
      autoUpdateTime: '03:30',
    });
    await db.createDocument(types.COLLECTIONS.DNS_ZONES, {
      provider: 'hetzner',
      name: 'example.org',
      zoneId: 'hz-1',
      apiToken: crypto.encrypt('zonen-token'),
      status: 'error',
      lastCheckedAt: '2026-11-25T10:00:00.000Z',
      lastError: 'abgelaufen',
    }, 'zone-1');
    await db.createDocument(types.COLLECTIONS.SERVICE_TOKENS, {
      name: 'deploy',
      tokenHash: 'a'.repeat(64),
      prefix: 'hapm_abcdefg',
      description: null,
      createdBy: 'ada@example.org',
      lastUsedAt: '2026-11-25T10:00:00.000Z',
      lastUsedIp: '10.0.0.9',
      revokedAt: null,
      scopes: null,
      areas: null,
      allowedIps: null,
    }, 'tok-1');

    primary = await snapshot();
    expect(primary.accounts.users.map((user) => user.email).sort()).toEqual(['ada@example.org', 'ben@example.org']);
    expect(primary.accounts.users[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(primary.accounts.accounts).toHaveLength(2);
    expect(primary.accounts.accounts.every((account) => account.providerId === 'credential' && account.password)).toBe(true);
    expect(primary.accounts.passkeys).toMatchObject([{ id: 'pk-ada', userId: ada, counter: 3, backedUp: true }]);
    // Im Klartext: der Schlüssel dieses Knotens gilt auf dem anderen nicht.
    expect(primary.accounts.twoFactor).toMatchObject([{ userId: ada, secret: TOTP_SECRET, enabled: true }]);
    expect(primary.accounts.twoFactor[0].recoveryCodes).toHaveLength(10);
    expect(primary.settings).toMatchObject({ acmeEmail: 'acme@example.org', smtpPass: 'smtp-geheim', exposure: 'internal' });
    expect(primary.settings).not.toHaveProperty('autoUpdateTime');
    expect(primary.dnsZones).toEqual([{ id: 'zone-1', provider: 'hetzner', name: 'example.org', zoneId: 'hz-1', access: 'zonen-token' }]);
    expect(primary.serviceTokens).toMatchObject([{ id: 'tok-1', name: 'deploy', tokenHash: 'a'.repeat(64) }]);
    expect(primary.serviceTokens[0]).not.toHaveProperty('lastUsedAt');
    // Was im Paket steht, nimmt die Prüfung des Folgeknotens an.
    expect(data.parseSyncData(JSON.parse(JSON.stringify(primary)))).toEqual(primary);
  });

  it('liest denselben Fingerabdruck, solange sich nichts geändert hat, auch nach einer Anmeldung', async () => {
    const before = await collect.localDataFingerprint();
    expect(await signIn('ada@example.org', PASSWORD)).not.toBeNull();
    expect(await signIn('ben@example.org', PASSWORD)).not.toBeNull();
    await users.recordLogin(ada);
    await db.updateDocument(types.COLLECTIONS.SERVICE_TOKENS, 'tok-1', { lastUsedAt: new Date().toISOString() });
    expect(await collect.localDataFingerprint()).toBe(before);
    expect(before).toBe(data.dataFingerprint(primary));
  });

  it('setzt den Stand auf einem Knoten ein, dessen Datenbank anders aussieht', async () => {
    // Was ein Folgeknoten vor dem Abgleich hat: ein eigenes Konto, andere Einstellungen, nichts vom Rest.
    const local = (await users.createUser({ email: 'lokal@example.org', name: 'Lokal', password: PASSWORD })).$id;
    expect(await signIn('lokal@example.org', PASSWORD)).not.toBeNull();
    await users.recordLogin(local);
    const twoFactor = await import('@/lib/two-factor');
    await twoFactor.remove2FA(ada);
    await twoFactor.store2FASecret(local, 'KRSXG5CTMVRXEZLU');
    await driver.sql()`update auth_passkeys set counter = 7 where id = 'pk-ada'`;
    await settings.updateSettings({ exposure: 'public', smtpPass: null, notifyRecipients: [] });
    await db.deleteDocument(types.COLLECTIONS.DNS_ZONES, 'zone-1');
    await db.createDocument(types.COLLECTIONS.DNS_ZONES, { provider: 'cloudflare', name: 'example.org', zoneId: 'cf-9', apiToken: crypto.encrypt('alt'), status: 'ok', lastCheckedAt: null, lastError: null }, 'zone-lokal');
    await db.createDocument(types.COLLECTIONS.SERVICE_TOKENS, { name: 'lokal', tokenHash: 'b'.repeat(64), prefix: 'hapm_lokal', description: null, createdBy: null, lastUsedAt: null, lastUsedIp: null, revokedAt: null, scopes: null, areas: null, allowedIps: null }, 'tok-lokal');
    expect(await collect.localDataFingerprint()).not.toBe(data.dataFingerprint(primary));

    // Auf dem Hauptknoten hat Ben inzwischen sein Passwort geändert.
    const hash = await (await config.auth()).$context.then((ctx) => ctx.password.hash(NEW_PASSWORD));
    primary.accounts.accounts.find((account) => account.userId === ben)!.password = hash;

    const result = await apply.applyData(data.parseSyncData(JSON.parse(JSON.stringify(primary))));
    expect(result.steps.filter((step) => !step.ok)).toEqual([]);
    expect(result).toMatchObject({ ok: true, dbOk: true, crowdsec: null });
    expect(result.steps.map((step) => step.label)).toEqual(['Einstellungen übernommen', 'Konten übernommen', 'DNS-Zonen übernommen', 'API-Keys übernommen']);
    expect(result.steps[1].detail).toBe('2 Konten, 1 entfernt, 1 Passwort geändert, 2 zweite Faktoren geändert');

    // Danach trägt die Datenbank genau den Stand des Pakets.
    expect(result.localFingerprint).toBe(data.dataFingerprint(primary));
    expect(await collect.localDataFingerprint()).toBe(data.dataFingerprint(primary));

    // Das Konto, das der Hauptknoten nicht kennt, ist weg, mit allem, was daran hing.
    expect((await users.listUsers()).map((user) => user.email)).toEqual(['ada@example.org', 'ben@example.org']);
    expect(await sessionsOf(local)).toBe(0);
    expect(await signIn('lokal@example.org', PASSWORD)).toBeNull();
    expect(await db.listAll(types.COLLECTIONS.USER_STATE)).toHaveLength(1);
    // Wer blieb, bleibt angemeldet. Wessen Passwort sich geändert hat, nicht.
    expect(await sessionsOf(ada)).toBe(1);
    expect(await sessionsOf(ben)).toBe(0);
    expect(await signIn('ben@example.org', PASSWORD)).toBeNull();
    expect(await signIn('ben@example.org', NEW_PASSWORD)).not.toBeNull();

    // Die Geheimnisse sind mit dem Schlüssel dieses Knotens lesbar.
    const twoFactorRows = await db.listAll<import('@/lib/types').TwoFactorConfig>(types.COLLECTIONS.TWO_FACTOR);
    expect(twoFactorRows).toHaveLength(1);
    expect(await twoFactor.get2FASecret(ada)).toBe(TOTP_SECRET);
    expect(await twoFactor.has2FAEnabled(ada)).toBe(true);
    const saved = await settings.getSettings();
    expect(saved).toMatchObject({ exposure: 'internal', notifyRecipients: ['ops@example.org'], autoUpdateTime: '03:30' });
    expect(crypto.decrypt(saved.smtpPass!)).toBe('smtp-geheim');
    const zones = await db.listAll<import('@/lib/types').DnsZone>(types.COLLECTIONS.DNS_ZONES);
    expect(zones).toMatchObject([{ $id: 'zone-1', provider: 'hetzner', zoneId: 'hz-1', status: 'ok', lastError: null }]);
    expect(crypto.decrypt(zones[0].apiToken)).toBe('zonen-token');
    const tokens = await db.listAll<import('@/lib/types').ServiceToken>(types.COLLECTIONS.SERVICE_TOKENS);
    // Wann der Key hier zuletzt benutzt wurde, bleibt stehen: das führt jeder Knoten selbst.
    expect(tokens).toMatchObject([{ $id: 'tok-1', name: 'deploy', lastUsedAt: expect.any(String), lastUsedIp: '10.0.0.9' }]);
    // Der Zähler eines Passkeys geht nicht zurück.
    expect((await collect.collectDbData()).accounts.passkeys[0].counter).toBe(7);
  });

  it('fasst beim zweiten Mal nichts an', async () => {
    const stamp = async () => ({
      users: (await driver.sql()`select id, updated_at::text from auth_users order by id`).map((row) => row.updated_at),
      accounts: (await driver.sql()`select id, updated_at::text from auth_accounts order by id`).map((row) => row.updated_at),
      zones: (await db.listAll(types.COLLECTIONS.DNS_ZONES)).map((row) => row.$updatedAt),
      tokens: (await db.listAll(types.COLLECTIONS.SERVICE_TOKENS)).map((row) => row.$updatedAt),
      twoFactor: (await db.listAll(types.COLLECTIONS.TWO_FACTOR)).map((row) => row.$updatedAt),
      settings: (await settings.getSettings()).$updatedAt,
    });
    const before = await stamp();
    const sessions = await sessionsOf(ben);
    const result = await apply.applyData(data.parseSyncData(JSON.parse(JSON.stringify(primary))));
    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => step.detail)).toEqual(['unverändert', '2 Konten', '1 Zone, unverändert', '1 API-Key, unverändert']);
    expect(await stamp()).toEqual(before);
    expect(await sessionsOf(ben)).toBe(sessions);
  });

  it('lässt ein Geheimnis, das der Hauptknoten nicht lesen konnte, auch hier unlesbar', async () => {
    const broken = data.parseSyncData(JSON.parse(JSON.stringify(primary)));
    broken.dnsZones[0].access = null;
    broken.accounts.twoFactor[0].secret = null;
    expect((await apply.applyData(broken)).ok).toBe(true);
    const twoFactor = await import('@/lib/two-factor');
    // Eingeschaltet und nicht lesbar heißt ausgesperrt, nicht „kein zweiter Faktor".
    expect(await twoFactor.has2FAEnabled(ada)).toBe(true);
    expect(await twoFactor.get2FASecret(ada)).toBeNull();
    const { tokenOf } = await import('@/lib/dns/store');
    const [zone] = await db.listAll<import('@/lib/types').DnsZone>(types.COLLECTIONS.DNS_ZONES);
    expect(() => tokenOf(zone)).toThrow(/entschlüsseln/);
    expect(await collect.localDataFingerprint()).toBe(data.dataFingerprint(broken));
    expect((await apply.applyData(data.parseSyncData(JSON.parse(JSON.stringify(primary))))).ok).toBe(true);
  });

  it('übernimmt die übrigen Teile, wenn einer scheitert', async () => {
    const half = data.parseSyncData(JSON.parse(JSON.stringify(primary)));
    // Die Prüfung der Einstellungen lehnt das ab, wie bei einer Eingabe in der Oberfläche.
    half.settings.smtpHost = 'kein gültiger name';
    half.serviceTokens[0].description = 'vom Hauptknoten';
    const result = await apply.applyData(half);
    expect(result).toMatchObject({ ok: false, dbOk: false });
    expect(result.steps.map((step) => [step.label, step.ok])).toEqual([
      ['Einstellungen übernehmen', false],
      ['Konten übernommen', true],
      ['DNS-Zonen übernommen', true],
      ['API-Keys übernommen', true],
    ]);
    expect((await settings.getSettings()).smtpHost).toBe('mail.example.org');
    expect((await db.listAll<import('@/lib/types').ServiceToken>(types.COLLECTIONS.SERVICE_TOKENS))[0].description).toBe('vom Hauptknoten');
    expect((await apply.applyData(data.parseSyncData(JSON.parse(JSON.stringify(primary))))).ok).toBe(true);
  });

  it('ändert auf einem Folgeknoten nichts, was der Abgleich überträgt', async () => {
    await store.updateSyncSettings({ role: 'replica' });
    const refused = { status: 409, message: expect.stringContaining('Folgeknoten') };
    await expect(users.createUser({ email: 'neu@example.org', name: 'Neu', password: PASSWORD })).rejects.toMatchObject(refused);
    await expect(users.changePassword(ada, PASSWORD, NEW_PASSWORD)).rejects.toMatchObject(refused);
    await expect(users.deleteUser(ben, ada)).rejects.toMatchObject(refused);
    const twoFactor = await import('@/lib/two-factor');
    await expect(twoFactor.remove2FA(ada)).rejects.toMatchObject(refused);
    await expect(twoFactor.replaceRecoveryCodes(ada)).rejects.toMatchObject(refused);
    await expect(settings.updateSettings({ exposure: 'public' })).rejects.toMatchObject(refused);
    await expect(settings.updateSettings({ smtpPass: 'anders' })).rejects.toMatchObject(refused);
    const { connectZone } = await import('@/lib/dns/connect');
    await expect(connectZone({ provider: 'cloudflare', domain: 'example.net', token: 'x' })).rejects.toMatchObject(refused);

    // Was jeder Knoten für sich einstellt, geht weiter, auch wenn ein Formular den Rest unverändert mitschickt.
    const saved = await settings.updateSettings({ autoUpdateTime: '02:15', exposure: 'internal', notifyRecipients: ['ops@example.org'] });
    expect(saved.autoUpdateTime).toBe('02:15');
    await users.setUserLocale(ada, 'en');
    expect(await collect.localDataFingerprint()).toBe(data.dataFingerprint(primary));

    // Der Abgleich selbst schreibt weiter.
    primary.settings.dnsWait = 90;
    expect((await apply.applyData(data.parseSyncData(JSON.parse(JSON.stringify(primary))))).ok).toBe(true);
    expect((await settings.getSettings()).dnsWait).toBe(90);
    await store.updateSyncSettings({ role: 'single' });
  });
});
