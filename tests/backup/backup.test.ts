import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkHostPath } from '@/lib/backup/settings';
import { HELPER_SCRIPT, backupFileName, parseBackupList } from '@/lib/backup/run';

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

/**
 * Das Skript des Helfers läuft als root und räumt Dateien weg. Eine echte Shell
 * rechnet es hier über ein Temp-Verzeichnis nach: was es schreibt, was es
 * liegen lässt und was es NICHT anfasst.
 */
describe('HELPER_SCRIPT', () => {
  const linux = process.platform === 'linux';

  it.runIf(linux)('schreibt das Archiv, behält die jüngsten und lässt Fremdes liegen', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hapm-backup-'));
    try {
      const backup = path.join(root, 'backup');
      for (const dir of ['data/.backup-staging/data', 'etc/haproxy', 'root/.acme.sh', 'backup']) {
        fs.mkdirSync(path.join(root, dir), { recursive: true });
      }
      fs.writeFileSync(path.join(root, 'data/.backup-staging/database.sql'), '-- dump');
      fs.writeFileSync(path.join(root, 'data/.backup-staging/data/secrets.json'), '{}');
      fs.writeFileSync(path.join(root, 'etc/haproxy/haproxy.cfg'), 'global');
      fs.writeFileSync(path.join(root, 'root/.acme.sh/account.conf'), '');
      for (const old of ['20260101-000000', '20260102-000000', '20260103-000000']) {
        fs.writeFileSync(path.join(backup, `hapm-backup-${old}.tar.gz`), 'alt');
      }
      fs.writeFileSync(path.join(backup, 'urlaub.tar.gz'), 'fremd');
      fs.writeFileSync(path.join(backup, 'hapm-backup-notizen.txt'), 'fremd');

      // Dieselben Pfade wie im Container, nur unter dem Temp-Verzeichnis.
      const script = HELPER_SCRIPT.split('/backup').join(backup)
        .split('"/data/').join(`"${root}/data/`)
        .split('-C /etc ').join(`-C ${root}/etc `)
        .split('-C /root ').join(`-C ${root}/root `);
      const name = 'hapm-backup-20261124-023000.tar.gz';
      const output = execFileSync('sh', ['-c', script], {
        env: { ...process.env, BACKUP_NAME: name, BACKUP_KEEP: '2' },
        encoding: 'utf8',
      });

      const left = fs.readdirSync(backup).sort();
      expect(left).toEqual([
        'hapm-backup-20260103-000000.tar.gz',
        name,
        'hapm-backup-notizen.txt',
        'urlaub.tar.gz',
      ].sort());
      expect(parseBackupList(output).map((file) => file.name)).toEqual([name, 'hapm-backup-20260103-000000.tar.gz']);

      const listing = execFileSync('tar', ['-tzf', path.join(backup, name)], { encoding: 'utf8' });
      expect(listing).toContain('database.sql');
      expect(listing).toContain('data/secrets.json');
      expect(listing).toContain('haproxy/haproxy.cfg');
      expect(listing).toContain('.acme.sh/account.conf');
      // Die Rechte: nur der Besitzer liest das Archiv, es enthält Schlüssel.
      expect(fs.statSync(path.join(backup, name)).mode & 0o077).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('nimmt Name und Anzahl aus der Umgebung und setzt nichts in den Text ein', () => {
    expect(HELPER_SCRIPT).toContain('${BACKUP_NAME}');
    expect(HELPER_SCRIPT).toContain('BACKUP_KEEP');
    expect(HELPER_SCRIPT).not.toMatch(/hapm-backup-\d{8}/);
  });
});
