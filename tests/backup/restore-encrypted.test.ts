import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Ein verschlüsseltes Archiv bereitlegen: mit gespeichertem Sicherungsschlüssel,
 * ohne, mit falschem, und mit einem eingegebenen (`lib/backup/restore.ts`,
 * `admit` und `unlockStaged`). gpg ist echt, die Archive entstehen mit denselben
 * Schaltern wie im Helfer. Die Prüfung des Inhalts (`inspectArchive`) hat ihren
 * eigenen Test und ist hier eine Attrappe, die Einstellungen ebenso.
 */

const settings = vi.hoisted(() => ({ stored: null as string | null, unreadable: false }));

vi.mock('@/lib/backup/settings', async (original) => ({
  ...(await original<typeof import('@/lib/backup/settings')>()),
  getBackupSettings: vi.fn(async () => ({ hostPath: null, keep: 14, time: '02:30', enabled: false, passphrase: null })),
  readPassphrase: vi.fn(() => {
    if (settings.unreadable) throw new Error('nicht lesbar');
    return settings.stored;
  }),
}));

vi.mock('@/lib/backup/archive', async (original) => ({
  ...(await original<typeof import('@/lib/backup/archive')>()),
  inspectArchive: vi.fn(async () => ({
    manifest: null,
    version: null,
    createdAt: null,
    createdLocal: '2026-11-24T02:30:00',
    contents: { databaseBytes: 1, haproxyFiles: 1, certificates: 0, acmeFiles: 1 },
    effectiveKeyFingerprint: 'abc',
    warnings: [],
    blockers: [],
  })),
}));

import { ApiError } from '@/lib/api';
import { archiveFormat } from '@/lib/backup/decrypt';
import { GPG_ENCRYPT_FLAGS } from '@/lib/backup/run';
import { discardStaged, readLocked, readStaged, stageUpload, unlockStaged } from '@/lib/backup/restore';

const GPG = (() => {
  try {
    execFileSync('bash', ['-c', 'command -v gpg'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
if (!GPG && process.env.CI) throw new Error('gpg fehlt in der CI: die Tests der Verschlüsselung dürfen dort nicht übersprungen werden.');
if (!GPG) console.warn('[backup: verschlüsseltes Archiv bereitlegen] übersprungen: gpg ist nicht im PATH.');

function shPath(p: string): string {
  if (process.platform !== 'win32') return p;
  return p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
}

const ACTOR = { userId: 'u1', userEmail: 'admin@example.org' };
const PASSPHRASE = 'der richtige Sicherungsschlüssel';

let root: string;
let previousData: string | undefined;
let previousContainer: string | undefined;

/** Ein kleines gzip, verschlüsselt wie im Helfer der Sicherung. */
function encryptedArchive(passphrase: string): Buffer {
  const plain = path.join(root, 'plain.tar.gz');
  const key = path.join(root, 'key');
  const out = path.join(root, 'out.gpg');
  fs.mkdirSync(path.join(root, 'inhalt'), { recursive: true });
  fs.writeFileSync(path.join(root, 'inhalt', 'database.sql'), '-- dump');
  execFileSync('sh', ['-c', 'tar -czf "$T" -C "$S" .'], {
    env: { ...process.env, T: shPath(plain), S: shPath(path.join(root, 'inhalt')) },
  });
  fs.writeFileSync(key, `${passphrase}\n`);
  execFileSync(
    'bash',
    ['-c', `home="$(mktemp -d)"; gpg --homedir "$home" ${GPG_ENCRYPT_FLAGS} --passphrase-file "$K" -o "$O" "$P"; code=$?; rm -rf "$home"; exit $code`],
    { env: { ...process.env, K: shPath(key), O: shPath(out), P: shPath(plain) } }
  );
  return fs.readFileSync(out);
}

function plainArchive(): Buffer {
  encryptedArchive(PASSPHRASE);
  return fs.readFileSync(path.join(root, 'plain.tar.gz'));
}

function upload(bytes: Buffer, name: string) {
  return stageUpload(new Blob([new Uint8Array(bytes)]).stream(), name, ACTOR);
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    return err as ApiError;
  }
  throw new Error('Hätte abgelehnt werden müssen.');
}

describe.skipIf(!GPG)('ein verschlüsseltes Archiv bereitlegen', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hapm-restore-enc-'));
    previousData = process.env.HAPM_DATA_DIR;
    previousContainer = process.env.HAPM_CONTAINER;
    process.env.HAPM_DATA_DIR = path.join(root, 'data');
    process.env.HAPM_CONTAINER = 'hapm';
    fs.mkdirSync(path.join(root, 'data'));
    settings.stored = null;
    settings.unreadable = false;
  });

  afterEach(() => {
    if (previousData === undefined) delete process.env.HAPM_DATA_DIR;
    else process.env.HAPM_DATA_DIR = previousData;
    if (previousContainer === undefined) delete process.env.HAPM_CONTAINER;
    else process.env.HAPM_CONTAINER = previousContainer;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const restoreDir = () => path.join(root, 'data', '.restore');

  it('nimmt ein unverschlüsseltes Archiv wie bisher', async () => {
    const staged = await upload(plainArchive(), 'alt.tar.gz');
    expect('check' in staged && staged.unlockedWith).toBe(null);
    expect(readLocked()).toBeNull();
    expect(readStaged()?.name).toBe('alt.tar.gz');
  });

  it('entschlüsselt mit dem gespeicherten Sicherungsschlüssel, ohne zu fragen', async () => {
    settings.stored = PASSPHRASE;
    const staged = await upload(encryptedArchive(PASSPHRASE), 'hapm-backup-20261124-023000.tar.gz.gpg');
    expect('check' in staged && staged.unlockedWith).toBe('stored');
    expect(readLocked()).toBeNull();
    // Was bereitliegt, ist das gewöhnliche Archiv: Prüfung und Helfer arbeiten wie immer.
    expect(archiveFormat(path.join(restoreDir(), 'archive.tar.gz'))).toBe('gzip');
    expect(fs.readdirSync(restoreDir()).sort()).toEqual(['archive.json', 'archive.tar.gz']);
  });

  it('lässt das Archiv warten, wenn kein Sicherungsschlüssel gespeichert ist, und nimmt dann den eingegebenen', async () => {
    const locked = await upload(encryptedArchive(PASSPHRASE), 'umzug.tar.gz.gpg');
    expect('check' in locked).toBe(false);
    expect(readLocked()).toMatchObject({ name: 'umzug.tar.gz.gpg', source: 'upload', storedFailed: false });
    expect(readStaged()).toBeNull();
    expect(fs.readdirSync(restoreDir()).sort()).toEqual(['archive.tar.gz.gpg', 'locked.json']);

    const wrong = await rejection(unlockStaged(readLocked()!.id, 'ein anderer Schlüssel', ACTOR));
    expect(wrong.message).toBe('Der Sicherungsschlüssel passt nicht zu diesem Archiv.');
    // Ein falscher Schlüssel kostet das Archiv nicht: es wartet weiter.
    expect(readLocked()).not.toBeNull();

    const staged = await unlockStaged(readLocked()!.id, PASSPHRASE, ACTOR);
    expect(staged.unlockedWith).toBe('entered');
    expect(staged.name).toBe('umzug.tar.gz.gpg');
    expect(readLocked()).toBeNull();
    expect(fs.readdirSync(restoreDir()).sort()).toEqual(['archive.json', 'archive.tar.gz']);
  });

  it('fragt nach, wenn der gespeicherte Sicherungsschlüssel nicht passt oder nicht lesbar ist', async () => {
    settings.stored = 'der Schlüssel dieses Servers';
    await upload(encryptedArchive(PASSPHRASE), 'fremd.tar.gz.gpg');
    expect(readLocked()).toMatchObject({ storedFailed: true });

    settings.unreadable = true;
    await upload(encryptedArchive(PASSPHRASE), 'fremd.tar.gz.gpg');
    expect(readLocked()).toMatchObject({ storedFailed: false });
  });

  it('lehnt ein beschädigtes Archiv ab und lässt nichts liegen', async () => {
    settings.stored = PASSPHRASE;
    const bytes = encryptedArchive(PASSPHRASE);
    const err = await rejection(upload(bytes.subarray(0, bytes.length - 30), 'halb.tar.gz.gpg'));
    expect(err.message).toBe(
      'Das Archiv lässt sich nicht entschlüsseln. Es ist beschädigt, unvollständig oder nicht mit gpg verschlüsselt.'
    );
    expect(readLocked()).toBeNull();
    expect(readStaged()).toBeNull();
    expect(fs.readdirSync(restoreDir())).toEqual([]);
  });

  it('entschlüsselt nur das Archiv, das die Seite gezeigt hat, und nimmt keine mehrzeilige Eingabe', async () => {
    await upload(encryptedArchive(PASSPHRASE), 'umzug.tar.gz.gpg');
    expect((await rejection(unlockStaged('eine-andere-kennung', PASSPHRASE, ACTOR))).status).toBe(409);
    expect((await rejection(unlockStaged(readLocked()!.id, '', ACTOR))).message).toBe('Der Sicherungsschlüssel fehlt.');
    expect((await rejection(unlockStaged(readLocked()!.id, `${PASSPHRASE}\nzweite Zeile`, ACTOR))).message).toBe(
      'Der Sicherungsschlüssel passt nicht zu diesem Archiv.'
    );
    expect(readLocked()).not.toBeNull();
  });

  it('verwirft auch ein wartendes Archiv', async () => {
    await upload(encryptedArchive(PASSPHRASE), 'umzug.tar.gz.gpg');
    expect(discardStaged()).toBe(true);
    expect(readLocked()).toBeNull();
    expect(fs.readdirSync(restoreDir())).toEqual([]);
    expect(discardStaged()).toBe(false);
  });
});
