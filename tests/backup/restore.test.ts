import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RESTORE_SCRIPT, STAGE_SCRIPT, parseProgress, progressLine } from '@/lib/backup/restore-script';

/**
 * Das Skript des Helfers `hapm-restore`, von einer echten Shell über ein
 * Temp-Verzeichnis nachgerechnet. `hapm-ctl` ist eine Attrappe, die jeden
 * Aufruf mitschreibt und auf Wunsch an einer Stelle scheitert. Geprüft wird,
 * was danach auf der Platte liegt: der Stand der Sicherung, oder, an jeder
 * Stelle, an der es scheitern kann, wieder der alte.
 */

function shPath(p: string): string {
  if (process.platform !== 'win32') return p;
  return p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
}

/** Die Attrappe von `hapm-ctl`. */
const FAKE_CTL = String.raw`#!/bin/sh
echo "$*" >> "$CTL_LOG"
case "$1" in
  restore-db)
    if [ "${'$'}{FAIL_DB:-}" = "${'$'}{2##*/}" ]; then echo "psql: ERROR: kaputt" >&2; exit 3; fi
    exit 0 ;;
  check)
    if grep -q zurueck "$2"; then echo "check sieht den Stand der Sicherung" >> "$CTL_LOG"; fi
    if [ -n "${'$'}{FAIL_CHECK:-}" ]; then echo "[ALERT] config file invalid"; exit 1; fi
    echo "Configuration file is valid"; exit 0 ;;
  reload)
    n=$(cat "$CTL_LOG.reloads" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$CTL_LOG.reloads"
    if [ -n "${'$'}{FAIL_RELOAD:-}" ] && [ "$n" = 1 ]; then echo "Success=0"; exit 1; fi
    exit 0 ;;
  stop|start) exit 0 ;;
esac
exit 2
`;

/** Ein `mv`, das bei einem bestimmten Namen scheitert, sonst das echte. */
const FAKE_MV = String.raw`#!/bin/sh
for arg in "$@"; do last="$arg"; done
for arg in "$@"; do
  case "$arg" in -*) ;; *) if [ "${'$'}{arg##*/}" = "${'$'}{FAIL_MV:-}" ] && [ "$arg" != "$last" ]; then echo "mv: kaputt" >&2; exit 1; fi ;; esac
done
exec "$REAL_MV" "$@"
`;

let root: string;
let dataDir: string;
let haproxyDir: string;
let acmeDir: string;
let ctlLog: string;

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Alle Dateien unter `dir` mit Inhalt, als sortierte Liste. */
function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string) => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      if (fs.statSync(full).isDirectory()) walk(full, `${prefix}${name}/`);
      else out.push(`${prefix}${name}=${fs.readFileSync(full, 'utf8')}`);
    }
  };
  walk(dir, '');
  return out;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hapm-restore-'));
  dataDir = path.join(root, 'data');
  haproxyDir = path.join(root, 'etc', 'haproxy');
  acmeDir = path.join(root, 'root', '.acme.sh');
  ctlLog = path.join(root, 'ctl.log');

  // Der Stand von heute.
  write(path.join(dataDir, 'secrets.json'), 'alt-schluessel');
  write(path.join(dataDir, 'login-attempts.json'), 'zaehler');
  write(path.join(haproxyDir, 'haproxy.cfg'), 'global # heute');
  write(path.join(haproxyDir, 'certs', 'heute.example.pem'), 'heute');
  write(path.join(haproxyDir, 'errors', '503.http'), 'heute');
  write(path.join(haproxyDir, '.versteckt'), 'heute');
  write(path.join(acmeDir, 'account.conf'), 'heute');
  write(path.join(dataDir, '.restore', 'before.sql'), '-- vorher');

  // Die Sicherung, im Aufbau des Helfers der Sicherung.
  const staging = path.join(root, 'src', 'staging');
  write(path.join(staging, 'database.sql'), '-- PostgreSQL database dump complete');
  write(path.join(staging, 'data', 'secrets.json'), 'schluessel-der-sicherung');
  write(path.join(root, 'src', 'etc', 'haproxy', 'haproxy.cfg'), 'global # zurueck');
  write(path.join(root, 'src', 'etc', 'haproxy', 'certs', 'damals.example.pem'), 'damals');
  write(path.join(root, 'src', 'etc', 'haproxy', 'errors', '503.http'), 'damals');
  write(path.join(root, 'src', 'etc', 'haproxy', 'hapm-lock', 'demo.json'), 'damals');
  write(path.join(root, 'src', 'home', '.acme.sh', 'account.conf'), 'damals');
  execFileSync('sh', ['-c', 'tar -czf "$T" -C "$S" . -C "$E" haproxy -C "$H" .acme.sh'], {
    env: {
      ...process.env,
      S: shPath(staging),
      E: shPath(path.join(root, 'src', 'etc')),
      H: shPath(path.join(root, 'src', 'home')),
      T: shPath(path.join(dataDir, '.restore', 'archive.tar.gz')),
    },
  });

  write(path.join(root, 'bin', 'ctl.sh'), FAKE_CTL);
  write(path.join(root, 'bin', 'mv'), FAKE_MV);
  fs.chmodSync(path.join(root, 'bin', 'mv'), 0o755);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function runScript(env: Record<string, string> = {}) {
  const realMv = execFileSync('sh', ['-c', 'command -v mv'], { encoding: 'utf8' }).trim();
  const result = spawnSync('sh', ['-c', RESTORE_SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
      REAL_MV: realMv,
      RESTORE_HAPM: 'hapm-id',
      RESTORE_DATA: shPath(dataDir),
      RESTORE_HAPROXY: shPath(haproxyDir),
      RESTORE_ACME: shPath(acmeDir),
      RESTORE_CTL: `sh ${shPath(path.join(root, 'bin', 'ctl.sh'))}`,
      CTL_LOG: shPath(ctlLog),
      ...env,
    },
  });
  const progress = parseProgress(fs.readFileSync(path.join(dataDir, '.restore', 'progress'), 'utf8'));
  const calls = fs.existsSync(ctlLog) ? fs.readFileSync(ctlLog, 'utf8').trim().split('\n') : [];
  return { code: result.status, progress, calls: calls.map((line) => line.replace(/\S*\/\.restore\//g, '')) };
}

const TODAY_HAPROXY = ['.versteckt=heute', 'certs/heute.example.pem=heute', 'errors/503.http=heute', 'haproxy.cfg=global # heute'];

function expectToday() {
  expect(tree(haproxyDir)).toEqual(TODAY_HAPROXY);
  expect(tree(acmeDir)).toEqual(['account.conf=heute']);
  expect(fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8')).toBe('alt-schluessel');
}

// Jeder Fall startet das Skript in einer echten Shell mit Dutzenden Kommandos.
// Unter Windows und wenn die ganze Suite parallel läuft, reichen die üblichen
// fünf Sekunden dafür nicht immer: der Fall scheiterte dann an der Zeit, nicht
// am Skript.
describe('RESTORE_SCRIPT', { timeout: 30_000 }, () => {
  it('spielt zurück: Datenbank, dann Dateien, prüft vor dem Neuladen und startet HAPM', () => {
    const { code, progress, calls } = runScript();
    expect(code).toBe(0);
    expect(calls).toEqual([
      'stop hapm-id',
      'restore-db new/database.sql',
      `check ${shPath(haproxyDir)}/haproxy.cfg`,
      'check sieht den Stand der Sicherung',
      'reload',
      'start hapm-id',
    ]);
    expect(progress.done).toEqual({ status: 'success', step: null });
    expect(progress.steps.map((s) => `${s.ok ? 'ok' : 'fail'} ${s.step}`)).toEqual([
      'ok prepare',
      'ok stop',
      'ok database',
      'ok files',
      'ok check',
      'ok reload',
      'ok start',
    ]);
    // Genau der Stand der Sicherung, nichts von heute übrig, keine Arbeitsordner.
    expect(tree(haproxyDir)).toEqual([
      'certs/damals.example.pem=damals',
      'errors/503.http=damals',
      'hapm-lock/demo.json=damals',
      'haproxy.cfg=global # zurueck',
    ]);
    expect(tree(acmeDir)).toEqual(['account.conf=damals']);
    expect(fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8')).toBe('schluessel-der-sicherung');
    // Was sonst im Daten-Ordner liegt, bleibt.
    expect(fs.readFileSync(path.join(dataDir, 'login-attempts.json'), 'utf8')).toBe('zaehler');
    expect(fs.existsSync(path.join(dataDir, '.restore', 'new'))).toBe(false);
  });

  it('tauscht zurück und spielt die Datenbank von vorher ein, wenn HAProxy die Konfiguration ablehnt', () => {
    const { code, progress, calls } = runScript({ FAIL_CHECK: '1' });
    expect(code).toBe(1);
    expectToday();
    expect(calls).toContain('restore-db before.sql --keep-sessions');
    expect(calls).not.toContain('reload');
    expect(calls[calls.length - 1]).toBe('start hapm-id');
    expect(progress.done).toEqual({ status: 'error', step: 'check' });
    expect(progress.steps.filter((s) => s.step.startsWith('rollback_')).map((s) => `${s.ok} ${s.step}`)).toEqual([
      'true rollback_files',
      'true rollback_database',
    ]);
    expect(fs.existsSync(path.join(haproxyDir, '.hapm-restore-old'))).toBe(false);
    expect(fs.existsSync(path.join(haproxyDir, '.hapm-restore-new'))).toBe(false);
  });

  it('lädt HAProxy nach dem Zurücktauschen noch einmal, wenn das Neuladen scheitert', () => {
    const { code, progress, calls } = runScript({ FAIL_RELOAD: '1' });
    expect(code).toBe(1);
    expectToday();
    expect(calls.filter((call) => call === 'reload')).toHaveLength(2);
    expect(progress.done).toEqual({ status: 'error', step: 'reload' });
    expect(progress.steps.map((s) => s.step)).toContain('rollback_reload');
  });

  it('lässt alles, wie es war, wenn die Datenbank nicht eingespielt wird', () => {
    const { code, progress, calls } = runScript({ FAIL_DB: 'database.sql' });
    expect(code).toBe(1);
    expectToday();
    expect(calls).toEqual(['stop hapm-id', 'restore-db new/database.sql', 'start hapm-id']);
    expect(progress.done).toEqual({ status: 'error', step: 'database' });
    expect(progress.steps.find((s) => s.step === 'database')?.detail).toContain('psql: ERROR: kaputt');
  });

  it('hält HAPM nicht an, wenn das Archiv sich nicht auspacken lässt', () => {
    fs.writeFileSync(path.join(dataDir, '.restore', 'archive.tar.gz'), 'kein archiv');
    const { code, progress, calls } = runScript();
    expect(code).toBe(1);
    expectToday();
    expect(calls).toEqual([]);
    expect(progress.done).toEqual({ status: 'error', step: 'prepare' });
  });

  it('tauscht zurück, wenn das Beiseitelegen des alten Stands mittendrin scheitert', () => {
    // `certs` ist schon beiseitegelegt, `errors` nicht.
    const { code, progress, calls } = runScript({ FAIL_MV: 'errors' });
    expect(code).toBe(1);
    expect(progress.done).toEqual({ status: 'error', step: 'files' });
    expectToday();
    expect(calls).toContain('restore-db before.sql --keep-sessions');
    expect(fs.existsSync(path.join(haproxyDir, '.hapm-restore-old'))).toBe(false);
  });

  it('tauscht zurück, wenn das Hineinlegen des neuen Stands mittendrin scheitert', () => {
    // Der alte Stand liegt schon beiseite, ein Teil des neuen ist drin: `hapm-lock` gibt es nur in der Sicherung.
    const { code, progress } = runScript({ FAIL_MV: 'hapm-lock' });
    expect(code).toBe(1);
    expect(progress.done).toEqual({ status: 'error', step: 'files' });
    expectToday();
    expect(fs.existsSync(path.join(haproxyDir, '.hapm-restore-new'))).toBe(false);
  });

  it('tauscht beide Ordner zurück, wenn erst acme.sh scheitert', () => {
    // HAProxy ist schon getauscht, acme.sh scheitert: beide kommen zurück.
    const { code, progress } = runScript({ FAIL_MV: 'account.conf' });
    expect(code).toBe(1);
    expect(progress.done).toEqual({ status: 'error', step: 'files' });
    expect(progress.steps.find((s) => s.step === 'rollback_files')?.ok).toBe(true);
    expectToday();
  });

  it('beginnt nicht, solange ein früherer Lauf .hapm-restore-old hinterlassen hat', () => {
    write(path.join(haproxyDir, '.hapm-restore-old', 'haproxy.cfg'), 'von damals');
    const { code, progress, calls } = runScript();
    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(progress.done).toEqual({ status: 'error', step: 'prepare' });
    expect(fs.readFileSync(path.join(haproxyDir, '.hapm-restore-old', 'haproxy.cfg'), 'utf8')).toBe('von damals');
    expect(fs.readFileSync(path.join(haproxyDir, 'haproxy.cfg'), 'utf8')).toBe('global # heute');
  });

  it('setzt nichts Veränderliches in den Text ein', () => {
    expect(RESTORE_SCRIPT).toContain('${RESTORE_DATA:-/data}');
    expect(RESTORE_SCRIPT).toContain('"$RESTORE_HAPM"');
    expect(STAGE_SCRIPT).toContain('"/backup/$RESTORE_NAME"');
  });
});

describe('parseProgress', () => {
  it('liest Schritte und Ergebnis und übergeht Unpassendes', () => {
    const text = [
      progressLine('ok', 'backup', '/srv/x.tar.gz'),
      progressLine('fail', 'check', 'zeile eins\nzeile zwei'),
      'Müll\n',
      'done error check\n',
    ].join('');
    expect(parseProgress(text)).toEqual({
      steps: [
        { step: 'backup', ok: true, detail: '/srv/x.tar.gz' },
        { step: 'check', ok: false, detail: 'zeile eins zeile zwei' },
      ],
      done: { status: 'error', step: 'check' },
    });
  });
});
