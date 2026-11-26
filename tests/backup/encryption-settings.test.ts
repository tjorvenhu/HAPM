import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Der Sicherungsschlüssel in den Einstellungen: er liegt verschlüsselt in der
 * Datenbank, nach außen geht nur, ob einer gesetzt ist, und ein Schlüssel, der
 * sich nicht mehr lesen lässt, gilt nicht stillschweigend als „keiner".
 * Die Datenbank ist hier eine Zeile im Speicher, die Verschlüsselung ist echt.
 */

const store = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  audit: [] as { action: string; details?: string }[],
}));

vi.mock('@/lib/db', () => ({
  getSingleton: vi.fn(async (_collection: string, _id: string, defaults: Record<string, unknown>) => {
    store.row ??= { $id: 'main', ...defaults };
    return store.row;
  }),
  updateDocument: vi.fn(async (_collection: string, _id: string, patch: Record<string, unknown>) => {
    store.row = { ...(store.row ?? { $id: 'main' }), ...patch };
    return store.row;
  }),
  listDocuments: vi.fn(async () => []),
  getDocument: vi.fn(),
  createDocument: vi.fn(),
  deleteWhere: vi.fn(),
  Query: { orderDesc: () => ({}), limit: () => ({}), equal: () => ({}), lessThan: () => ({}) },
  COLLECTIONS: {},
}));
vi.mock('@/lib/audit', () => ({
  logAudit: vi.fn(async (entry: { action: string; details?: string }) => {
    store.audit.push(entry);
  }),
}));
vi.mock('@/lib/docker', () => ({ ownContainer: () => 'hapm', engine: {} }));

process.env.HAPM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hapm-backup-settings-'));
process.env.ENCRYPTION_KEY = 'test-encryption-key-at-least-32-characters-long';

const { ApiError } = await import('@/lib/api');
const { backupOverview, changeBackupPassphrase, changeBackupSettings } = await import('@/lib/backup/actions');
const { PASSPHRASE_UNREADABLE, getBackupSettings, passphraseState, readPassphrase } = await import('@/lib/backup/settings');
const { archiveNameFor } = await import('@/lib/backup/run');

const ACTOR = { userId: 'u1', userEmail: 'admin@example.org', ip: '203.0.113.9' };
const PASSPHRASE = 'Ein Sicherungsschlüssel für den Test';

beforeEach(() => {
  store.row = null;
  store.audit = [];
});

afterAll(() => {
  fs.rmSync(process.env.HAPM_DATA_DIR!, { recursive: true, force: true });
});

describe('der Sicherungsschlüssel in den Einstellungen', () => {
  it('ist ohne Angabe nicht gesetzt: die Vorgabe bleibt unverschlüsselt', async () => {
    const overview = await backupOverview();
    expect(overview.settings).toMatchObject({ encrypted: false, passphraseUnreadable: false });
    expect(readPassphrase(await getBackupSettings())).toBeNull();
    expect((await archiveNameFor(new Date(2026, 10, 24, 2, 30, 0))).fileName).toBe('hapm-backup-20261124-023000.tar.gz');
  });

  it('liegt verschlüsselt in der Datenbank, und die Übersicht nennt ihn nicht', async () => {
    const overview = await changeBackupPassphrase(PASSPHRASE, ACTOR);
    expect(overview.settings).toMatchObject({ encrypted: true, passphraseUnreadable: false });

    const stored = String(store.row?.passphrase);
    expect(stored).not.toContain(PASSPHRASE);
    expect(stored).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    // Weder im Klartext noch als Chiffrat: nach außen geht nur „gesetzt".
    const sent = JSON.stringify(overview);
    expect(sent).not.toContain(PASSPHRASE);
    expect(sent).not.toContain(stored);
    expect(Object.keys(overview.settings).sort()).toEqual(['enabled', 'encrypted', 'hostPath', 'keep', 'passphraseUnreadable', 'time']);

    expect(readPassphrase(await getBackupSettings())).toBe(PASSPHRASE);
    expect(await archiveNameFor(new Date(2026, 10, 24, 2, 30, 0), '-vor-ruecksicherung')).toEqual({
      fileName: 'hapm-backup-20261124-023000-vor-ruecksicherung.tar.gz.gpg',
      passphrase: PASSPHRASE,
    });
  });

  it('steht im Protokoll, ohne den Schlüssel selbst: gesetzt, geändert, entfernt', async () => {
    await changeBackupPassphrase(PASSPHRASE, ACTOR);
    await changeBackupPassphrase(`${PASSPHRASE} neu`, ACTOR);
    await changeBackupPassphrase(null, ACTOR);
    // Entfernen, wo nichts gesetzt ist, ist kein Ereignis.
    await changeBackupPassphrase(null, ACTOR);
    expect(store.audit.map((entry) => entry.action)).toEqual([
      'backup_encryption_set',
      'backup_encryption_set',
      'backup_encryption_removed',
    ]);
    expect(store.audit.map((entry) => entry.details)).toEqual([
      'Sicherungen werden verschlüsselt',
      'Sicherungsschlüssel geändert',
      'Sicherungen werden nicht mehr verschlüsselt',
    ]);
    expect(JSON.stringify(store.audit)).not.toContain(PASSPHRASE);
    expect((await backupOverview()).settings.encrypted).toBe(false);
  });

  it('lehnt einen Schlüssel ab, der die Regeln nicht erfüllt, und lässt den Stand, wie er ist', async () => {
    await changeBackupPassphrase(PASSPHRASE, ACTOR);
    for (const bad of ['zu kurz', ' mit Leerzeichen davor', 'zwei\nZeilen im Schlüssel', 42, undefined, '']) {
      await expect(changeBackupPassphrase(bad, ACTOR)).rejects.toBeInstanceOf(ApiError);
    }
    expect(readPassphrase(await getBackupSettings())).toBe(PASSPHRASE);
  });

  it('bleibt, wenn die übrigen Einstellungen geändert werden: API und MCP kommen an ihn nicht heran', async () => {
    await changeBackupPassphrase(PASSPHRASE, ACTOR);
    // Was die interne API und `update_backup_settings` aufrufen. Ein Feld `passphrase` im Rumpf zählt nicht.
    const overview = await changeBackupSettings({ keep: 7, passphrase: null, encrypted: false }, ACTOR);
    expect(overview.settings).toMatchObject({ keep: 7, encrypted: true });
    expect(readPassphrase(await getBackupSettings())).toBe(PASSPHRASE);
  });

  it('gilt als gesetzt, aber unlesbar, wenn er sich nicht entschlüsseln lässt: gesichert wird dann nicht im Klartext', async () => {
    await changeBackupPassphrase(PASSPHRASE, ACTOR);
    // Wie nach einem geänderten ENCRYPTION_KEY: das Chiffrat passt nicht mehr zum Schlüssel.
    const [iv, tag, data] = String(store.row!.passphrase).split(':');
    store.row!.passphrase = `${iv}:${'0'.repeat(tag.length)}:${data}`;

    const settings = await getBackupSettings();
    expect(passphraseState(settings)).toEqual({ encrypted: true, passphraseUnreadable: true });
    expect(() => readPassphrase(settings)).toThrow(PASSPHRASE_UNREADABLE);
    await expect(archiveNameFor(new Date())).rejects.toThrow(PASSPHRASE_UNREADABLE);
    expect((await backupOverview()).settings).toMatchObject({ encrypted: true, passphraseUnreadable: true });
  });
});
