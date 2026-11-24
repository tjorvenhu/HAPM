import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkHostPath } from '@/lib/backup/settings';
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

  /** Dieselben Pfade wie im Container, nur unter dem Temp-Verzeichnis. */
  function run(env: Record<string, string>): string {
    const base = shPath(root);
    const script = HELPER_SCRIPT.split('/backup').join(`${base}/backup`)
      .split('"/data/').join(`"${base}/data/`)
      .split('-C /etc ').join(`-C ${base}/etc `)
      .split('-C /root ').join(`-C ${base}/root `);
    return execFileSync('sh', ['-c', script], { env: { ...process.env, ...env }, encoding: 'utf8' });
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
});
