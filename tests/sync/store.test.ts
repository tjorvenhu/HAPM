import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEST_DATABASE_URL, announceSkip, createTestSchema, dropTestSchema } from '../helpers/test-database';

/**
 * Was der Abgleich in der Datenbank hält, gegen ein echtes Postgres: die Zeile
 * mit der Rolle entsteht einmal und behält ihre Kennung, die Collections sind
 * angelegt, und der Kopplungsschlüssel liegt nicht im Klartext da.
 *
 * Läuft nur, wenn `TEST_DATABASE_URL` auf ein Postgres zeigt
 * (`tests/helpers/test-database.ts`).
 */

const SCHEMA = `hapm_test_sync_${process.pid}`;

type Store = typeof import('@/lib/sync/store');
type Driver = typeof import('@/lib/db/postgres-driver');
let store: Store;
let driver: Driver;
let dataDir: string;

const suite = TEST_DATABASE_URL ? describe : describe.skip;
if (!TEST_DATABASE_URL) announceSkip('tests/sync/store');

suite('Abgleich: Datenbank', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hapm-sync-store-'));
    process.env.HAPM_DATA_DIR = dataDir;
    await createTestSchema(SCHEMA);
    driver = await import('@/lib/db/postgres-driver');
    store = await import('@/lib/sync/store');
  });

  afterAll(async () => {
    await driver.closeDatabase();
    await dropTestSchema(SCHEMA);
    delete process.env.HAPM_DATA_DIR;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('beginnt als einzelner Knoten mit einer Kennung, die bleibt', async () => {
    const first = await store.getSyncSettings();
    expect(first).toMatchObject({ role: 'single', pairingKey: null, primary: null, applied: null, rejected: null });
    expect(first.nodeId).toMatch(/^[0-9a-f]{32}$/);
    expect((await store.getSyncSettings()).nodeId).toBe(first.nodeId);
  });

  it('ändert nur, was genannt ist', async () => {
    const before = await store.getSyncSettings();
    const after = await store.updateSyncSettings({ role: 'replica' });
    expect(after.role).toBe('replica');
    expect(after.nodeId).toBe(before.nodeId);
    await store.updateSyncSettings({ role: 'single' });
  });

  it('hält den Kopplungsschlüssel verschlüsselt', async () => {
    const key = 'hapmsync_' + 'k'.repeat(43);
    await store.updateSyncSettings({ pairingKey: store.sealKey(key) });
    const stored = (await store.getSyncSettings()).pairingKey!;
    expect(stored).not.toContain(key);
    expect(store.openKey(stored)).toBe(key);
    // Mit einem anderen `encryptionKey` (ein zurückgespielter fremder Stand) ist er nicht lesbar, und das wirft nicht.
    expect(store.openKey('00:00:00')).toBeNull();
    expect(store.openKey(null)).toBeNull();
  });

  it('führt Gegenstellen einzeln, damit Zustand und Anlegen einander nicht überschreiben', async () => {
    const data = {
      url: 'http://10.0.0.2:7080',
      key: store.sealKey('hapmsync_' + 'a'.repeat(43)),
      nodeId: 'b'.repeat(32),
      addedAt: new Date().toISOString(),
      lastCheckAt: null,
      reachable: null,
      inSync: null,
      lastSyncAt: null,
      lastError: null,
      warnings: [],
      hapmVersion: null,
      haproxyVersion: null,
    };
    const a = await store.createPeer({ ...data, name: 'proxy02' });
    const b = await store.createPeer({ ...data, name: 'proxy03', url: 'http://10.0.0.3:7080' });
    await store.updatePeer(a.$id, { inSync: true, warnings: [{ code: 'crowdsec_off' }] });
    expect(await store.getPeer(a.$id)).toMatchObject({ name: 'proxy02', inSync: true, warnings: [{ code: 'crowdsec_off' }] });
    expect(await store.getPeer(b.$id)).toMatchObject({ name: 'proxy03', inSync: null });
    expect((await store.listPeers()).map((peer) => peer.name).sort()).toEqual(['proxy02', 'proxy03']);
    await store.deletePeer(a.$id);
    expect((await store.listPeers()).map((peer) => peer.name)).toEqual(['proxy03']);
  });

  it('listet Läufe, den neuesten zuerst, und schließt beim Start, was offen blieb', async () => {
    const run = (startedAt: string, status: 'running' | 'success') =>
      store.createSyncRun({ direction: 'send', trigger: 'change', status, startedAt, completedAt: null, peers: 'proxy02', steps: '[]', error: null, triggeredBy: 'scheduler' });
    const old = await run('2026-11-26T10:00:00.000Z', 'success');
    const open = await run('2026-11-26T11:00:00.000Z', 'running');

    expect((await store.listSyncRuns(10)).map((entry) => entry.$id)).toEqual([open.$id, old.$id]);

    const log = new store.RunLog(open.$id);
    await log.add('Stand übertragen', true, '12 KB');
    expect((await store.getSyncRunRow(open.$id)).steps).toBe(JSON.stringify([{ label: 'Stand übertragen', ok: true, detail: '12 KB' }]));

    expect(await store.closeOpenSyncRuns()).toBe(1);
    expect(await store.getSyncRunRow(open.$id)).toMatchObject({ status: 'error', error: store.SYNC_INTERRUPTED });
    expect((await store.getSyncRunRow(old.$id)).status).toBe('success');

    expect(await store.pruneSyncRuns('2026-11-26T10:30:00.000Z')).toBe(1);
    expect((await store.listSyncRuns(10)).map((entry) => entry.$id)).toEqual([open.$id]);
  });
});
