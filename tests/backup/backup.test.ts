import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkHostPath } from '@/lib/backup/settings';
import { archiveFormat, decryptArchive } from '@/lib/backup/decrypt';
import { PASSPHRASE_MAX, PASSPHRASE_MIN, checkPassphrase, isEncryptedName } from '@/lib/backup/passphrase';
import {
  BEFORE_RESTORE_DATA_FILE,
  BEFORE_RESTORE_SUFFIX,
  HELPER_SCRIPT,
  backupFileName,
  isBackupArchiveName,
  parseBackupList,
} from '@/lib/backup/run';

describe('checkHostPath', () => {
  it('nimmt einen gewöhnlichen Ordner und räumt Schrägstriche auf', () => {
    expect(checkHostPath('/srv/hapm-backup/')).toEqual({ path: '/srv/hapm-backup' });
    expect(checkHostPath('  /mnt//nas/HAPM Sicherung ')).toEqual({ path: '/mnt/nas/HAPM Sicherung' });
  });

  it('lehnt ab, was Docker anders läse, als es dasteht', () => {
    // Ein Doppelpunkt trennt in einer Einbindung Quelle, Ziel und Optionen.
    expect(checkHostPath('/srv/backup:/etc')).toHaveProperty('error');
    expect(checkHostPath('/srv/../etc')).toHaveProperty('error');
    expect(checkHostPath('relativ/pfad')).toHaveProperty('error');
    expect(checkHostPath('/srv/$(reboot)')).toHaveProperty('error');
    expect(checkHostPath('')).toHaveProperty('error');
  });

  it('lehnt Ordner des Systems ab, in denen der Lauf als root aufräumen würde', () => {
    for (const forbidden of ['/', '/etc', '/usr', '/var/lib/docker', '/proc/1', '/dev/shm']) {
      expect(checkHostPath(forbidden), forbidden).toHaveProperty('error');
    }
    expect(checkHostPath('/etc-backup')).toEqual({ path: '/etc-backup' });
    expect(checkHostPath('/var/backups/hapm')).toEqual({ path: '/var/backups/hapm' });
  });
});

describe('backupFileName', () => {
  it('trägt den Zeitpunkt so, dass der Name sortiert', () => {
    expect(backupFileName(new Date(2026, 10, 4, 2, 30, 5))).toBe('hapm-backup-20261104-023005.tar.gz');
  });

  it('kennzeichnet die Sicherung vor dem Zurückspielen, und auch sie gilt als Archiv von HAPM', () => {
    const name = backupFileName(new Date(2026, 10, 4, 2, 30, 5), BEFORE_RESTORE_SUFFIX);
    expect(name).toBe('hapm-backup-20261104-023005-vor-ruecksicherung.tar.gz');
    expect(isBackupArchiveName(name)).toBe(true);
    expect(isBackupArchiveName('hapm-backup-20261104-023005-anders.tar.gz')).toBe(false);
    expect(isBackupArchiveName('../hapm-backup-20261104-023005.tar.gz')).toBe(false);
  });

  it('hängt bei einem verschlüsselten Archiv .gpg an, und auch das gilt als Archiv von HAPM', () => {
    const plain = backupFileName(new Date(2026, 10, 4, 2, 30, 5), '', true);
    expect(plain).toBe('hapm-backup-20261104-023005.tar.gz.gpg');
    const before = backupFileName(new Date(2026, 10, 4, 2, 30, 5), BEFORE_RESTORE_SUFFIX, true);
    expect(before).toBe('hapm-backup-20261104-023005-vor-ruecksicherung.tar.gz.gpg');
    for (const name of [plain, before]) {
      expect(isBackupArchiveName(name)).toBe(true);
      expect(isEncryptedName(name)).toBe(true);
    }
    expect(isEncryptedName('hapm-backup-20261104-023005.tar.gz')).toBe(false);
    expect(isBackupArchiveName('hapm-backup-20261104-023005.tar.gz.gpg.txt')).toBe(false);
    expect(isBackupArchiveName('hapm-backup-20261104-023005.gpg')).toBe(false);
    // Ohne eingestellten Ordner bleibt die Sicherung vor dem Zurückspielen unverschlüsselt.
    expect(isEncryptedName(BEFORE_RESTORE_DATA_FILE)).toBe(false);
  });
});

describe('checkPassphrase', () => {
  const text = (input: unknown) => {
    const checked = checkPassphrase(input);
    return 'error' in checked ? checked.error.text : null;
  };

  it('nimmt einen Schlüssel, wie er eingegeben wurde, auch mit Leerzeichen und Umlauten darin', () => {
    expect(checkPassphrase('Vier Wörter für später')).toEqual({ passphrase: 'Vier Wörter für später' });
    expect(checkPassphrase('x'.repeat(PASSPHRASE_MIN))).toEqual({ passphrase: 'x'.repeat(PASSPHRASE_MIN) });
  });

  it('lehnt ab, was zu kurz, zu lang oder kein Text ist', () => {
    expect(text('x'.repeat(PASSPHRASE_MIN - 1))).toBe('Der Sicherungsschlüssel braucht mindestens {min} Zeichen.');
    expect(text('x'.repeat(PASSPHRASE_MAX + 1))).toBe('Der Sicherungsschlüssel darf höchstens {max} Zeichen lang sein.');
    expect(text('')).toBe('Der Sicherungsschlüssel fehlt.');
    expect(text(12345678901234)).toBe('Der Sicherungsschlüssel fehlt.');
    expect(text(undefined)).toBe('Der Sicherungsschlüssel fehlt.');
  });

  it('lehnt ab, was gpg anders läse, als es gespeichert ist', () => {
    // gpg liest eine Zeile: nach einem Umbruch wäre der Rest des Schlüssels weg.
    expect(text('erste zeile\nzweite zeile')).toBe(
      'Der Sicherungsschlüssel darf keine Zeilenumbrüche und keine Steuerzeichen enthalten.'
    );
    expect(text('mit\ttabulator darin')).toBe(
      'Der Sicherungsschlüssel darf keine Zeilenumbrüche und keine Steuerzeichen enthalten.'
    );
    expect(text(' leerzeichen davor')).toBe('Der Sicherungsschlüssel darf nicht mit einem Leerzeichen beginnen oder enden.');
    expect(text('leerzeichen danach ')).toBe('Der Sicherungsschlüssel darf nicht mit einem Leerzeichen beginnen oder enden.');
  });
});

describe('parseBackupList', () => {
  it('liest die Liste am Ende der Ausgabe und nichts davor', () => {
    const output = [
      'tar: irgendeine Meldung',
      '12 hapm-backup-20200101-000000.tar.gz',
      '---HAPM-BACKUP-LIST---',
      '2048 hapm-backup-20261124-023000.tar.gz',
      '1024 hapm-backup-20261123-023000.tar.gz',
      'unpassende zeile',
      '',
    ].join('\n');
    expect(parseBackupList(output)).toEqual([
      { sizeBytes: 2048, name: 'hapm-backup-20261124-023000.tar.gz' },
      { sizeBytes: 1024, name: 'hapm-backup-20261123-023000.tar.gz' },
    ]);
  });

  it('ist leer, wenn der Helfer nie bis zur Liste kam', () => {
    expect(parseBackupList('tar: Cannot open: Permission denied')).toEqual([]);
  });
});

/** Der Pfad, wie die Shell ihn liest. Unter Windows (Git Bash) `/c/…`, sonst unverändert. */
function shPath(p: string): string {
  if (process.platform !== 'win32') return p;
  return p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
}

/**
 * Das Skript des Helfers läuft als root und räumt Dateien weg. Eine echte Shell
 * rechnet es hier über ein Temp-Verzeichnis nach: was es schreibt, was es
 * liegen lässt und was es NICHT anfasst.
 */
describe('HELPER_SCRIPT', () => {
  let root: string;
  let backup: string;

  function setup() {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hapm-backup-'));
    backup = path.join(root, 'backup');
    for (const dir of ['data/.backup-staging/data', 'etc/haproxy', 'root/.acme.sh', 'backup']) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
    }
    fs.writeFileSync(path.join(root, 'data/.backup-staging/database.sql'), '-- dump');
    fs.writeFileSync(path.join(root, 'data/.backup-staging/manifest.json'), '{}');
    fs.writeFileSync(path.join(root, 'data/.backup-staging/data/secrets.json'), '{}');
    fs.writeFileSync(path.join(root, 'etc/haproxy/haproxy.cfg'), 'global');
    fs.writeFileSync(path.join(root, 'root/.acme.sh/account.conf'), '');
  }

  /** Dieselben Pfade wie im Container, nur unter dem Temp-Verzeichnis. bash wie im Helfer (`pipefail`). */
  function run(env: Record<string, string>): string {
    const base = shPath(root);
    const script = HELPER_SCRIPT.split('/backup').join(`${base}/backup`)
      .split('"/data/').join(`"${base}/data/`)
      .split('-C /etc ').join(`-C ${base}/etc `)
      .split('-C /root ').join(`-C ${base}/root `);
    return execFileSync('bash', ['-c', script], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }


  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('schreibt das Archiv, behält die jüngsten, lässt Fremdes und Sicherungen vor dem Zurückspielen liegen', () => {
    setup();
    for (const old of ['20260101-000000', '20260102-000000', '20260103-000000']) {
      fs.writeFileSync(path.join(backup, `hapm-backup-${old}.tar.gz`), 'alt');
    }
    // Die älteste von allen, aber vor einem Zurückspielen geschrieben: sie bleibt.
    fs.writeFileSync(path.join(backup, 'hapm-backup-20250101-000000-vor-ruecksicherung.tar.gz'), 'vorher');
    fs.writeFileSync(path.join(backup, 'urlaub.tar.gz'), 'fremd');
    fs.writeFileSync(path.join(backup, 'hapm-backup-notizen.txt'), 'fremd');

    const name = 'hapm-backup-20261124-023000.tar.gz';
    const output = run({ BACKUP_NAME: name, BACKUP_KEEP: '2' });

    expect(fs.readdirSync(backup).sort()).toEqual(
      [
        'hapm-backup-20250101-000000-vor-ruecksicherung.tar.gz',
        'hapm-backup-20260103-000000.tar.gz',
        name,
        'hapm-backup-notizen.txt',
        'urlaub.tar.gz',
      ].sort()
    );
    expect(parseBackupList(output).map((file) => file.name)).toEqual([
      name,
      'hapm-backup-20260103-000000.tar.gz',
      'hapm-backup-20250101-000000-vor-ruecksicherung.tar.gz',
    ]);

    const listing = execFileSync('sh', ['-c', 'tar -tzf "$F"'], {
      env: { ...process.env, F: shPath(path.join(backup, name)) },
      encoding: 'utf8',
    });
    expect(listing).toContain('database.sql');
    expect(listing).toContain('manifest.json');
    expect(listing).toContain('data/secrets.json');
    expect(listing).toContain('haproxy/haproxy.cfg');
    expect(listing).toContain('.acme.sh/account.conf');
    // Die Rechte: nur der Besitzer liest das Archiv, es enthält Schlüssel.
    if (process.platform !== 'win32') expect(fs.statSync(path.join(backup, name)).mode & 0o077).toBe(0);
  });

  it('räumt nichts weg, wenn BACKUP_PRUNE aus ist (die Sicherung vor dem Zurückspielen)', () => {
    setup();
    for (const old of ['20260101-000000', '20260102-000000']) {
      fs.writeFileSync(path.join(backup, `hapm-backup-${old}.tar.gz`), 'alt');
    }
    const name = backupFileName(new Date(2026, 10, 24, 10, 15, 0), BEFORE_RESTORE_SUFFIX);
    run({ BACKUP_NAME: name, BACKUP_KEEP: '1', BACKUP_PRUNE: '0' });
    expect(fs.readdirSync(backup).sort()).toEqual(
      ['hapm-backup-20260101-000000.tar.gz', 'hapm-backup-20260102-000000.tar.gz', name].sort()
    );
  });

  it('schreibt in den Daten-Ordner, wenn BACKUP_DIR dorthin zeigt, und ersetzt die vorige Datei', () => {
    setup();
    fs.writeFileSync(path.join(root, 'data', BEFORE_RESTORE_DATA_FILE), 'vorige');
    run({ BACKUP_NAME: BEFORE_RESTORE_DATA_FILE, BACKUP_KEEP: '0', BACKUP_PRUNE: '0', BACKUP_DIR: `${shPath(root)}/data` });
    expect(fs.readFileSync(path.join(root, 'data', BEFORE_RESTORE_DATA_FILE)).length).toBeGreaterThan(20);
    expect(fs.readdirSync(path.join(root, 'data')).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('nimmt Name und Anzahl aus der Umgebung und setzt nichts in den Text ein', () => {
    expect(HELPER_SCRIPT).toContain('${BACKUP_NAME}');
    expect(HELPER_SCRIPT).toContain('BACKUP_KEEP');
    expect(HELPER_SCRIPT).not.toMatch(/hapm-backup-\d{8}/);
  });

  it('nimmt den Sicherungsschlüssel aus einer Datei und nie als Argument oder aus der Umgebung', () => {
    expect(HELPER_SCRIPT).toContain('--passphrase-file "$key"');
    expect(HELPER_SCRIPT).not.toMatch(/--passphrase[ =]/);
    expect(HELPER_SCRIPT).not.toMatch(/BACKUP_PASSPHRASE|BACKUP_KEY=/);
  });

  it('lässt die Zahl der Archive zählen, ob verschlüsselt oder nicht', () => {
    setup();
    fs.writeFileSync(path.join(backup, 'hapm-backup-20260101-000000.tar.gz'), 'alt');
    fs.writeFileSync(path.join(backup, 'hapm-backup-20260102-000000.tar.gz.gpg'), 'alt');
    fs.writeFileSync(path.join(backup, 'hapm-backup-20260103-000000.tar.gz'), 'alt');
    fs.writeFileSync(path.join(backup, 'hapm-backup-20250101-000000-vor-ruecksicherung.tar.gz.gpg'), 'vorher');
    fs.writeFileSync(path.join(backup, 'notizen.tar.gz.gpg'), 'fremd');

    const name = 'hapm-backup-20261124-023000.tar.gz';
    const output = run({ BACKUP_NAME: name, BACKUP_KEEP: '3' });
    expect(fs.readdirSync(backup).sort()).toEqual(
      [
        'hapm-backup-20250101-000000-vor-ruecksicherung.tar.gz.gpg',
        'hapm-backup-20260102-000000.tar.gz.gpg',
        'hapm-backup-20260103-000000.tar.gz',
        name,
        'notizen.tar.gz.gpg',
      ].sort()
    );
    expect(parseBackupList(output).map((file) => file.name)).toEqual([
      name,
      'hapm-backup-20260103-000000.tar.gz',
      'hapm-backup-20260102-000000.tar.gz.gpg',
      'hapm-backup-20250101-000000-vor-ruecksicherung.tar.gz.gpg',
    ]);
  });

  it('schreibt in einen leeren Ordner, auch ohne dass es etwas aufzuräumen gibt', () => {
    setup();
    // Mit `pipefail` endete der Lauf sonst an einem grep ohne Treffer.
    const name = 'hapm-backup-20261124-023000-vor-ruecksicherung.tar.gz';
    const output = run({ BACKUP_NAME: name, BACKUP_KEEP: '1' });
    expect(fs.readdirSync(backup)).toEqual([name]);
    expect(parseBackupList(output).map((file) => file.name)).toEqual([name]);
  });
});

/**
 * Verschlüsseln im Helfer, entschlüsseln wie beim Zurückspielen
 * (`decryptArchive`) und wie von Hand nach `docs/betrieb.md`. Braucht gpg: im
 * Abbild liegt es, auf den Runnern der CI auch, in Git Bash unter Windows
 * ebenfalls. Fehlt es, sagen die Tests das und werden übersprungen.
 */
const GPG = (() => {
  try {
    execFileSync('bash', ['-c', 'command -v gpg'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
// In der CI darf das nicht still ausfallen: dort ist gpg da, und fehlt es einmal, soll der Lauf es sagen.
if (!GPG && process.env.CI) throw new Error('gpg fehlt in der CI: die Tests der Verschlüsselung dürfen dort nicht übersprungen werden.');
if (!GPG) console.warn('[backup: Verschlüsselung] übersprungen: gpg ist nicht im PATH.');

describe.skipIf(!GPG)('HELPER_SCRIPT mit Sicherungsschlüssel', () => {
  const PASSPHRASE = 'Ein Sicherungsschlüssel mit Ümlaut 42';
  let root: string;
  let backup: string;

  function setup() {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hapm-backup-enc-'));
    backup = path.join(root, 'backup');
    for (const dir of ['data/.backup-staging/data', 'etc/haproxy', 'root/.acme.sh', 'backup']) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
    }
    fs.writeFileSync(path.join(root, 'data/.backup-staging/database.sql'), '-- dump');
    fs.writeFileSync(path.join(root, 'data/.backup-staging/manifest.json'), '{}');
    fs.writeFileSync(path.join(root, 'data/.backup-staging/data/secrets.json'), '{"encryptionKey":"geheim-im-archiv"}');
    fs.writeFileSync(path.join(root, 'etc/haproxy/haproxy.cfg'), 'global');
    fs.writeFileSync(path.join(root, 'root/.acme.sh/account.conf'), '');
  }

  function script(): string {
    const base = shPath(root);
    return HELPER_SCRIPT.split('/backup').join(`${base}/backup`)
      .split('"/data/').join(`"${base}/data/`)
      .split('-C /etc ').join(`-C ${base}/etc `)
      .split('-C /root ').join(`-C ${base}/root `);
  }

  function run(env: Record<string, string>) {
    return spawnSync('bash', ['-c', script()], { env: { ...process.env, ...env }, encoding: 'utf8' });
  }

  /** Der Sicherungsschlüssel als Datei, wie `writeArchive` ihn dem Helfer hinlegt. */
  function keyFile(passphrase: string): string {
    const file = path.join(root, 'data', '.backup-passphrase');
    fs.writeFileSync(file, `${passphrase}\n`, { mode: 0o600 });
    return shPath(file);
  }

  function listArchive(file: string): string {
    return execFileSync('sh', ['-c', 'tar --force-local -tzf "$F"'], {
      env: { ...process.env, F: file.replace(/\\/g, '/') },
      encoding: 'utf8',
    });
  }

  function encrypted(name = 'hapm-backup-20261124-023000.tar.gz.gpg'): string {
    const result = run({ BACKUP_NAME: name, BACKUP_KEEP: '5', BACKUP_ENCRYPT: '1', BACKUP_KEY_FILE: keyFile(PASSPHRASE) });
    expect(result.status, result.stderr).toBe(0);
    return path.join(backup, name);
  }

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('schreibt ein Archiv, das gpg ist und kein gzip, und nennt es in der Liste', () => {
    setup();
    const name = 'hapm-backup-20261124-023000.tar.gz.gpg';
    const result = run({ BACKUP_NAME: name, BACKUP_KEEP: '5', BACKUP_ENCRYPT: '1', BACKUP_KEY_FILE: keyFile(PASSPHRASE) });
    expect(result.status, result.stderr).toBe(0);

    const file = path.join(backup, name);
    expect(archiveFormat(file)).toBe('gpg');
    // Nichts im Klartext: weder der Inhalt noch ein vorläufiges Archiv daneben.
    expect(fs.readFileSync(file).includes('geheim-im-archiv')).toBe(false);
    expect(fs.readdirSync(backup)).toEqual([name]);
    expect(parseBackupList(result.stdout)).toEqual([{ name, sizeBytes: fs.statSync(file).size }]);
    // Der Schlüssel steht in keiner Ausgabe.
    expect(result.stdout + result.stderr).not.toContain(PASSPHRASE);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o077).toBe(0);
  });

  it('lässt sich mit dem Schlüssel entschlüsseln, und heraus kommt das Archiv', async () => {
    setup();
    const file = encrypted();
    const target = path.join(root, 'entschluesselt.tar.gz');
    expect(await decryptArchive(file, target, PASSPHRASE)).toEqual({ result: 'ok', detail: '' });
    expect(archiveFormat(target)).toBe('gzip');
    const listing = listArchive(target);
    for (const member of ['database.sql', 'manifest.json', 'data/secrets.json', 'haproxy/haproxy.cfg', '.acme.sh/account.conf']) {
      expect(listing).toContain(member);
    }
    expect(fs.existsSync(`${target}.part`)).toBe(false);
  });

  it('lässt sich von Hand entschlüsseln, mit dem Kommando aus docs/betrieb.md', () => {
    setup();
    const file = encrypted();
    const target = path.join(root, 'von-hand.tar.gz');
    // Von Hand fragt gpg nach dem Schlüssel. Hier kommt er über stdin, sonst dasselbe Kommando.
    const result = spawnSync(
      'bash',
      ['-c', 'export GNUPGHOME="$(mktemp -d)"; gpg --batch --pinentry-mode loopback --passphrase-fd 0 -o "$T" -d "$F"; code=$?; rm -rf "$GNUPGHOME"; exit $code'],
      { env: { ...process.env, T: shPath(target), F: shPath(file) }, input: `${PASSPHRASE}\n`, encoding: 'utf8' }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(listArchive(target)).toContain('database.sql');
  });

  it('meldet einen falschen Schlüssel als solchen und schreibt nichts', async () => {
    setup();
    const file = encrypted();
    const target = path.join(root, 'falsch.tar.gz');
    expect((await decryptArchive(file, target, 'ein ganz anderer Schlüssel')).result).toBe('wrong-passphrase');
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(`${target}.part`)).toBe(false);
  });

  it('lehnt ein verändertes und ein abgeschnittenes Archiv ab, auch mit dem richtigen Schlüssel', async () => {
    setup();
    const file = encrypted();
    const bytes = fs.readFileSync(file);

    const changed = Buffer.from(bytes);
    changed[bytes.length - 40] ^= 0xff;
    const changedFile = path.join(root, 'veraendert.tar.gz.gpg');
    fs.writeFileSync(changedFile, changed);
    const target = path.join(root, 'kaputt.tar.gz');
    expect((await decryptArchive(changedFile, target, PASSPHRASE)).result).toBe('damaged');
    // gpg schreibt, bevor es die Prüfsumme kennt. Liegen bleiben darf davon nichts.
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(`${target}.part`)).toBe(false);

    const cutFile = path.join(root, 'halb.tar.gz.gpg');
    fs.writeFileSync(cutFile, bytes.subarray(0, Math.floor(bytes.length / 2)));
    expect((await decryptArchive(cutFile, target, PASSPHRASE)).result).toBe('damaged');
    expect(fs.existsSync(target)).toBe(false);
  });

  it('räumt auch zwischen verschlüsselten Archiven nur die ältesten ohne Zusatz weg', () => {
    setup();
    for (const old of ['20260101-000000.tar.gz', '20260102-000000.tar.gz.gpg', '20260103-000000.tar.gz.gpg']) {
      fs.writeFileSync(path.join(backup, `hapm-backup-${old}`), 'alt');
    }
    fs.writeFileSync(path.join(backup, 'hapm-backup-20250101-000000-vor-ruecksicherung.tar.gz.gpg'), 'vorher');
    const name = 'hapm-backup-20261124-023000.tar.gz.gpg';
    const result = run({ BACKUP_NAME: name, BACKUP_KEEP: '2', BACKUP_ENCRYPT: '1', BACKUP_KEY_FILE: keyFile(PASSPHRASE) });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readdirSync(backup).sort()).toEqual(
      ['hapm-backup-20250101-000000-vor-ruecksicherung.tar.gz.gpg', 'hapm-backup-20260103-000000.tar.gz.gpg', name].sort()
    );
  });

  it('scheitert ohne Schlüsseldatei und mit einer leeren, statt unverschlüsselt oder mit leerem Schlüssel zu schreiben', () => {
    setup();
    const name = 'hapm-backup-20261124-023000.tar.gz.gpg';
    const missing = run({ BACKUP_NAME: name, BACKUP_KEEP: '5', BACKUP_ENCRYPT: '1', BACKUP_KEY_FILE: `${shPath(root)}/data/fehlt` });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('Der Sicherungsschlüssel fehlt.');

    const empty = path.join(root, 'data', '.backup-passphrase');
    fs.writeFileSync(empty, '');
    expect(run({ BACKUP_NAME: name, BACKUP_KEEP: '5', BACKUP_ENCRYPT: '1', BACKUP_KEY_FILE: shPath(empty) }).status).not.toBe(0);
    expect(fs.readdirSync(backup)).toEqual([]);
  });

  it('gilt als gescheitert, wenn tar scheitert, und lässt kein halbes Archiv liegen', () => {
    setup();
    // Ohne `pipefail` hätte gpg die leere Ausgabe von tar sauber verschlüsselt, und der Lauf gälte als gelungen.
    fs.rmSync(path.join(root, 'root/.acme.sh'), { recursive: true });
    const name = 'hapm-backup-20261124-023000.tar.gz.gpg';
    const result = run({ BACKUP_NAME: name, BACKUP_KEEP: '5', BACKUP_ENCRYPT: '1', BACKUP_KEY_FILE: keyFile(PASSPHRASE) });
    expect(result.status).not.toBe(0);
    expect(fs.readdirSync(backup)).toEqual([]);
    expect(parseBackupList(result.stdout)).toEqual([]);
  });
});
