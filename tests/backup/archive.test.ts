import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ArchiveError,
  assessKey,
  checkEntries,
  createdFromName,
  inspectArchive,
  normalizeEntryName,
  parseListing,
  type ArchiveEntry,
} from '@/lib/backup/archive';
import { buildManifest, compareVersions, keyFingerprint, parseManifest } from '@/lib/backup/manifest';

/**
 * Die Prüfung eines Archivs vor dem Zurückspielen. Die Archive entstehen hier
 * mit einem echten `tar`, so wie der Helfer der Sicherung sie schreibt
 * (`-C staging .` und `-C /etc haproxy`), und werden mit demselben Kommando
 * gelesen wie im Container.
 */

/** Der Pfad, wie die Shell ihn liest. Unter Windows (Git Bash) `/c/…`, sonst unverändert. */
function shPath(p: string): string {
  if (process.platform !== 'win32') return p;
  return p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
}

/** Der Pfad für `inspectArchive`: GNU tar mit `--force-local` nimmt unter Windows `C:/…`. */
function tarPath(p: string): string {
  return p.replace(/\\/g, '/');
}

const DUMP = '--\n-- PostgreSQL database dump\n--\nSELECT 1;\n--\n-- PostgreSQL database dump complete\n--\n';
const FILE_KEY = 'a'.repeat(64);

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hapm-archive-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

interface Layout {
  dump?: string | null;
  secrets?: string | null;
  manifest?: object | null;
  haproxy?: boolean;
  acme?: boolean;
}

/** Ein Archiv im Aufbau des Helfers: Zwischenordner mit `./`, HAProxy und acme.sh über ihren Namen. */
function makeArchive(name: string, layout: Layout = {}): string {
  const staging = path.join(root, 'staging');
  const etc = path.join(root, 'etc');
  const home = path.join(root, 'home');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.join(staging, 'data'), { recursive: true });
  fs.mkdirSync(path.join(etc, 'haproxy', 'certs'), { recursive: true });
  fs.mkdirSync(path.join(home, '.acme.sh'), { recursive: true });
  if (layout.dump !== null) fs.writeFileSync(path.join(staging, 'database.sql'), layout.dump ?? DUMP);
  if (layout.secrets !== null) {
    fs.writeFileSync(
      path.join(staging, 'data', 'secrets.json'),
      layout.secrets ?? JSON.stringify({ sessionSecret: 'b'.repeat(64), encryptionKey: FILE_KEY })
    );
  }
  if (layout.manifest) fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(layout.manifest));
  fs.writeFileSync(path.join(etc, 'haproxy', 'haproxy.cfg'), 'global\n');
  fs.writeFileSync(path.join(etc, 'haproxy', 'certs', '000-hapm-default.pem'), 'pem');
  fs.writeFileSync(path.join(etc, 'haproxy', 'certs', 'demo.example.pem'), 'pem');
  fs.writeFileSync(path.join(home, '.acme.sh', 'account.conf'), '');

  const target = path.join(root, name);
  const parts = ['-C "$S" .'];
  if (layout.haproxy !== false) parts.push('-C "$E" haproxy');
  if (layout.acme !== false) parts.push('-C "$H" .acme.sh');
  execFileSync('sh', ['-c', `tar -czf "$T" ${parts.join(' ')}`], {
    env: { ...process.env, S: shPath(staging), E: shPath(etc), H: shPath(home), T: shPath(target) },
  });
  return target;
}

function inspect(file: string, name: string, envKey: string | null = null, currentVersion: string | null = '0.5.0') {
  return inspectArchive(tarPath(file), { name, currentVersion, envKey });
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ArchiveError);
    return (err as ArchiveError).reason.text;
  }
  throw new Error('Die Prüfung hätte das Archiv ablehnen müssen.');
}

describe('inspectArchive mit echtem tar', () => {
  it('nimmt eine Sicherung mit Manifest und liest Fassung, Zeitpunkt und Inhalt', async () => {
    const manifest = buildManifest({ kind: 'manual', encryptionKey: FILE_KEY, keyFromEnvironment: false });
    const file = makeArchive('neu.tar.gz', { manifest: { ...manifest, version: '0.5.0' } });
    const check = await inspect(file, 'neu.tar.gz');
    expect(check.version).toBe('0.5.0');
    expect(check.createdAt).toBe(manifest.createdAt);
    expect(check.createdLocal).toBeNull();
    expect(check.contents).toMatchObject({ haproxyFiles: 3, certificates: 2, acmeFiles: 1 });
    expect(check.contents.databaseBytes).toBe(Buffer.byteLength(DUMP));
    expect(check.blockers).toEqual([]);
    expect(check.warnings).toEqual([]);
    expect(check.effectiveKeyFingerprint).toBe(keyFingerprint(FILE_KEY));
  });

  it('nimmt eine ältere Sicherung ohne Manifest: Fassung unbekannt, Zeitpunkt aus dem Namen', async () => {
    const file = makeArchive('hapm-backup-20261103-021500.tar.gz');
    const check = await inspect(file, 'hapm-backup-20261103-021500.tar.gz');
    expect(check.manifest).toBeNull();
    expect(check.version).toBeNull();
    expect(check.createdLocal).toBe('2026-11-03T02:15:00');
    expect(check.blockers).toEqual([]);
  });

  it('nimmt ohne Manifest und ohne passenden Namen den Zeitpunkt der Datenbank', async () => {
    const file = makeArchive('umzug.tar.gz');
    const check = await inspect(file, 'umzug.tar.gz');
    expect(check.createdLocal).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/);
  });

  it('lehnt ein Archiv ohne database.sql ab', async () => {
    const file = makeArchive('ohne-db.tar.gz', { dump: null });
    expect(await rejection(inspect(file, 'ohne-db.tar.gz'))).toBe('Im Archiv fehlt {file}. Eine Sicherung von HAPM enthält es immer.');
  });

  it('lehnt eine abgeschnittene Datenbank ab', async () => {
    const file = makeArchive('halb.tar.gz', { dump: '--\n-- PostgreSQL database dump\n--\nCOPY public.x' });
    expect(await rejection(inspect(file, 'halb.tar.gz'))).toBe('Die Datenbank im Archiv ist unvollständig: die Schlusszeile von pg_dump fehlt.');
  });

  it('lehnt ein beschädigtes Archiv ab (abgeschnitten)', async () => {
    const file = makeArchive('kaputt.tar.gz');
    const bytes = fs.readFileSync(file);
    fs.writeFileSync(file, bytes.subarray(0, Math.floor(bytes.length / 2)));
    expect(await rejection(inspect(file, 'kaputt.tar.gz'))).toBe(
      'Das Archiv lässt sich nicht vollständig lesen. Es ist beschädigt, unvollständig oder kein .tar.gz-Archiv.'
    );
  });

  it('lehnt eine Datei ab, die kein .tar.gz ist', async () => {
    const file = path.join(root, 'notizen.tar.gz');
    fs.writeFileSync(file, 'nur Text, kein Archiv\n');
    expect(await rejection(inspect(file, 'notizen.tar.gz'))).toBe(
      'Das Archiv lässt sich nicht vollständig lesen. Es ist beschädigt, unvollständig oder kein .tar.gz-Archiv.'
    );
  });

  it('lehnt ein fremdes Archiv ab', async () => {
    const other = path.join(root, 'urlaub');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'foto.jpg'), 'jpg');
    const file = path.join(root, 'urlaub.tar.gz');
    execFileSync('sh', ['-c', 'tar -czf "$T" -C "$S" .'], { env: { ...process.env, S: shPath(other), T: shPath(file) } });
    expect(await rejection(inspect(file, 'urlaub.tar.gz'))).toBe(
      'Das ist keine Sicherung von HAPM. Es fehlen Datenbank, Schlüssel und Konfiguration.'
    );
  });

  it('lehnt einen unlesbaren Schlüssel ab', async () => {
    const file = makeArchive('schluessel.tar.gz', { secrets: '{"sessionSecret":"x"}' });
    expect(await rejection(inspect(file, 'schluessel.tar.gz'))).toBe('Der Schlüssel im Archiv (data/secrets.json) ist nicht lesbar.');
  });

  it('sperrt, wenn ENCRYPTION_KEY nicht zum Schlüssel der Sicherung passt', async () => {
    const manifest = buildManifest({ kind: 'manual', encryptionKey: FILE_KEY, keyFromEnvironment: false });
    const file = makeArchive('env.tar.gz', { manifest });
    const check = await inspect(file, 'env.tar.gz', 'c'.repeat(64));
    expect(check.blockers.map((m) => m.text)).toHaveLength(2);
  });

  it('warnt vor einer neueren Fassung, ohne zu sperren', async () => {
    const manifest = { ...buildManifest({ kind: 'manual', encryptionKey: FILE_KEY, keyFromEnvironment: false }), version: '0.9.0' };
    const file = makeArchive('neuer.tar.gz', { manifest });
    const check = await inspect(file, 'neuer.tar.gz');
    expect(check.warnings.map((m) => m.text)).toEqual(['Die Sicherung stammt aus HAPM {archive}. Hier läuft die ältere Fassung {current}.']);
    expect(check.blockers).toEqual([]);
  });
});

function entry(pathName: string, type: ArchiveEntry['type'] = 'file', linkTarget: string | null = null): ArchiveEntry {
  return { path: pathName, raw: pathName, type, sizeBytes: 1, mtime: '2026-11-24 10:00', linkTarget };
}

const COMPLETE = [entry('database.sql'), entry('data', 'dir'), entry('data/secrets.json'), entry('haproxy', 'dir'), entry('haproxy/haproxy.cfg'), entry('.acme.sh', 'dir')];

describe('checkEntries', () => {
  it('lehnt Namen ab, die aus dem Ordner hinausführen, und Verweise dorthin', () => {
    for (const bad of [
      entry('../etc/passwd'),
      entry('/etc/passwd'),
      entry('haproxy/certs', 'symlink', '/etc'),
      entry('haproxy/x', 'symlink', '../../root'),
      entry('haproxy/dev', 'other'),
    ]) {
      expect(checkEntries([...COMPLETE, bad]), bad.path).toHaveProperty('error');
    }
  });

  it('nimmt einen Verweis innerhalb des Ordners', () => {
    expect(checkEntries([...COMPLETE, entry('haproxy/certs/a.pem', 'symlink', 'b.pem')])).toHaveProperty('contents');
  });

  it('verlangt .acme.sh', () => {
    expect(checkEntries(COMPLETE.filter((e) => e.path !== '.acme.sh'))).toHaveProperty('error');
  });
});

describe('parseListing und normalizeEntryName', () => {
  it('liest die Ausgabe von tar -tv mit und ohne ./ davor', () => {
    const entries = parseListing(
      [
        'drwx------ root/root         0 2026-11-24 10:15 ./',
        '-rw------- root/root      1234 2026-11-24 10:15 ./database.sql',
        'drwxr-xr-x root/root         0 2026-11-24 10:15 haproxy/',
        'lrwxrwxrwx root/root         0 2026-11-24 10:15 haproxy/link -> haproxy.cfg',
        'tar: irgendwas',
      ].join('\n')
    );
    expect(entries.map((e) => [e.path, e.type, e.sizeBytes, e.linkTarget])).toEqual([
      ['', 'dir', 0, null],
      ['database.sql', 'file', 1234, null],
      ['haproxy', 'dir', 0, null],
      ['haproxy/link', 'symlink', 0, 'haproxy.cfg'],
    ]);
    expect(normalizeEntryName('././data/secrets.json')).toBe('data/secrets.json');
  });
});

describe('Manifest und Schlüssel', () => {
  it('liest ein Manifest und lehnt Fremdes ab', () => {
    const manifest = buildManifest({ kind: 'before-restore', encryptionKey: 'k', keyFromEnvironment: true });
    expect(parseManifest(JSON.stringify(manifest))).toEqual(manifest);
    expect(parseManifest('{"app":"anderes","createdAt":"2026-01-01T00:00:00Z"}')).toBeNull();
    expect(parseManifest('kein json')).toBeNull();
  });

  it('vergleicht Fassungen nur in der Form x.y.z', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('0.4.0', '0.4.0')).toBe(0);
    expect(compareVersions('dev', '0.4.0')).toBeNull();
  });

  it('sperrt eine Sicherung, die mit ENCRYPTION_KEY geschrieben wurde, wenn er hier fehlt', () => {
    const manifest = buildManifest({ kind: 'manual', encryptionKey: 'env-key', keyFromEnvironment: true });
    const result = assessKey({ manifest, fileKey: 'file-key', envKey: null });
    expect(result.blockers).toHaveLength(2);
    expect(assessKey({ manifest, fileKey: 'file-key', envKey: 'env-key' }).blockers).toEqual([]);
  });

  it('warnt ohne Manifest nur, wenn die Umgebung einen anderen Schlüssel setzt', () => {
    expect(assessKey({ manifest: null, fileKey: 'f', envKey: null })).toMatchObject({ warnings: [], blockers: [] });
    expect(assessKey({ manifest: null, fileKey: 'f', envKey: 'e' }).warnings).toHaveLength(1);
  });

  it('liest den Zeitpunkt aus dem Namen, auch mit Zusatz', () => {
    expect(createdFromName('hapm-backup-20261124-101500-vor-ruecksicherung.tar.gz')).toBe('2026-11-24T10:15:00');
    expect(createdFromName('irgendwas.tar.gz')).toBeNull();
  });
});
