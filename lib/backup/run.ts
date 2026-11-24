/**
 * Die Sicherung: ein Archiv mit allem, was diese Installation ausmacht, in einem
 * Ordner auf dem Server.
 *
 * Im Archiv:
 *  - `database.sql`   die Datenbank von HAPM (Konten, Einstellungen, Historie)
 *  - `data/`          `secrets.json`, der Schlüssel zu den verschlüsselten Werten
 *  - `haproxy/`       `/etc/haproxy`: Konfiguration, Zertifikate, Fehlerseiten
 *  - `.acme.sh/`      acme.sh mit Konto, Zertifikaten und Erneuerungseinträgen
 *
 * Nicht im Archiv: das Log von HAProxy und die Abbilder.
 *
 * ── Warum ein Helfer-Container ──
 *
 * Der Ordner liegt auf dem Server, nicht im Container, und er wird in der
 * Oberfläche eingestellt. Ein Container kann sich nachträglich keinen Ordner
 * einbinden. Also startet HAPM für jeden Lauf einen zweiten Container aus dem
 * eigenen Abbild, der die Volumes von HAPM (nur lesend) und den Ordner bekommt
 * und nichts tut, als das Archiv zu schreiben und alte wegzuräumen. So braucht
 * es für einen anderen Ordner weder eine Änderung an Compose noch einen Neustart.
 *
 * ── Warum die Datenbank vorher herausgeschrieben wird ──
 *
 * Die Dateien einer laufenden Datenbank zu kopieren ergibt ein Archiv, das sich
 * vielleicht nicht mehr öffnen lässt. `pg_dump` schreibt einen stimmigen Stand.
 * Er läuft im Postgres-Container, sein Ergebnis kommt in einen Zwischenordner
 * im Daten-Volume, und von dort nimmt es der Helfer.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createDocument, deleteWhere, listDocuments, updateDocument, Query } from '../db';
import { ApiError } from '../api';
import { logAudit } from '../audit';
import { dataPath } from '../paths';
import { engine, ownContainer } from '../docker';
import type { DbDoc, HaproxyStep, RunStatus } from '../types';
import { BACKUP_RUNS, getBackupSettings } from './settings';

export interface BackupFile {
  name: string;
  sizeBytes: number;
}

export interface BackupRun extends DbDoc {
  status: RunStatus;
  startedAt: string;
  completedAt: string | null;
  hostPath: string;
  fileName: string | null;
  sizeBytes: number | null;
  /** Was nach dem Lauf im Ordner liegt, als JSON-Text von `BackupFile[]`. */
  files: string | null;
  steps: string | null;
  error: string | null;
  triggeredBy: string | null;
}

export interface BackupActor {
  userId: string;
  userEmail: string;
  ip?: string;
}

const STAGING = '.backup-staging';
const LIST_MARK = '---HAPM-BACKUP-LIST---';
const HELPER_TIMEOUT_MS = 20 * 60 * 1000;

const globalLock = globalThis as unknown as { __hapmBackupRunning?: boolean };

export function backupRunning(): boolean {
  return Boolean(globalLock.__hapmBackupRunning);
}

function postgresContainer(): string {
  return process.env.HAPM_POSTGRES_CONTAINER || 'hapm-postgres';
}

/** `hapm-backup-20261124-023000.tar.gz`: der Zeitpunkt sortiert die Archive. */
export function backupFileName(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `hapm-backup-${stamp}.tar.gz`;
}

/**
 * Was der Helfer ausführt. Fester Text: Name und Anzahl kommen über die
 * Umgebung herein und nie in den Text, der Ordner ist eine Einbindung.
 *
 * Geschrieben wird unter einem vorläufigen Namen und erst danach umbenannt: ein
 * abgebrochener Lauf hinterlässt so kein Archiv, das wie ein fertiges aussieht
 * und als jüngstes ein gutes verdrängt.
 */
export const HELPER_SCRIPT = [
  'set -eu',
  'umask 077',
  'tmp="/backup/.${BACKUP_NAME}.tmp"',
  'trap \'rm -f "$tmp"\' EXIT',
  `tar -czf "$tmp" -C "/data/${STAGING}" . -C /etc haproxy -C /root .acme.sh`,
  'mv "$tmp" "/backup/${BACKUP_NAME}"',
  // Älteste zuerst weg. Der Name trägt den Zeitpunkt, also sortiert `ls` richtig.
  'ls -1 /backup | grep -E "^hapm-backup-[0-9]{8}-[0-9]{6}\\.tar\\.gz$" | sort -r | tail -n "+$((BACKUP_KEEP + 1))" | while IFS= read -r old; do rm -f -- "/backup/$old"; done',
  `echo '${LIST_MARK}'`,
  'ls -1 /backup | grep -E "^hapm-backup-[0-9]{8}-[0-9]{6}\\.tar\\.gz$" | sort -r | while IFS= read -r f; do printf "%s %s\\n" "$(stat -c %s "/backup/$f")" "$f"; done',
].join('\n');

/** Die Liste am Ende der Ausgabe des Helfers: `<bytes> <name>` je Zeile. */
export function parseBackupList(output: string): BackupFile[] {
  const at = output.lastIndexOf(LIST_MARK);
  if (at === -1) return [];
  const files: BackupFile[] = [];
  for (const line of output.slice(at + LIST_MARK.length).split('\n')) {
    const match = /^(\d+) (hapm-backup-\d{8}-\d{6}\.tar\.gz)$/.exec(line.trim());
    if (match) files.push({ sizeBytes: Number(match[1]), name: match[2] });
  }
  return files;
}

class StepLog {
  readonly steps: HaproxyStep[] = [];
  constructor(private readonly runId: string) {}

  async add(label: string, ok: boolean, detail?: string): Promise<void> {
    this.steps.push({ label, ok, ...(detail ? { detail: detail.slice(0, 1500) } : {}) });
    await updateDocument<BackupRun>(BACKUP_RUNS, this.runId, { steps: JSON.stringify(this.steps) }).catch(
      () => undefined
    );
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Schreibt die Datenbank in den Zwischenordner. */
async function dumpDatabase(staging: string): Promise<number> {
  const name = process.env.HAPM_DATABASE_NAME || 'hapm';
  const user = process.env.HAPM_DATABASE_USER || 'hapm';
  const result = await engine.exec(
    postgresContainer(),
    // `--clean --if-exists`: beim Einspielen wird ersetzt, was schon da ist.
    ['pg_dump', '-U', user, '-d', name, '--no-owner', '--clean', '--if-exists'],
    { timeoutMs: 10 * 60 * 1000 }
  );
  if (result.code !== 0 || !result.stdout.includes('PostgreSQL database dump complete')) {
    throw new Error(`pg_dump ist gescheitert: ${(result.stderr || result.stdout).trim().slice(-400) || `Exit-Code ${result.code}`}`);
  }
  const target = path.join(staging, 'database.sql');
  fs.writeFileSync(target, result.stdout, { mode: 0o600 });
  return fs.statSync(target).size;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- Antworten der Engine */
async function runHelper(hostPath: string, fileName: string, keep: number): Promise<{ output: string; code: number }> {
  const own = ownContainer();
  if (!own) throw new Error('HAPM läuft nicht in einem Container. Die Sicherung braucht Docker.');
  const self: any = await engine.inspectContainer(own);

  const helper = `hapm-backup-${Date.now()}`;
  await engine.createContainer(helper, {
    Image: self.Image,
    Entrypoint: ['sh', '-c'],
    Cmd: [HELPER_SCRIPT],
    Env: [`BACKUP_NAME=${fileName}`, `BACKUP_KEEP=${keep}`],
    User: 'root',
    HostConfig: {
      // Alle Volumes von HAPM, nur lesend. Geschrieben wird allein in den Ordner.
      VolumesFrom: [`${self.Id}:ro`],
      Binds: [`${hostPath}:/backup`],
      NetworkMode: 'none',
    },
  });
  try {
    await engine.start(helper);
    const code = await engine.wait(helper, HELPER_TIMEOUT_MS);
    const output = await engine.logs(helper, { tail: 2000 }).catch(() => '');
    return { output, code };
  } finally {
    await engine.removeContainer(helper, { force: true }).catch(() => undefined);
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function execute(run: BackupRun, keep: number, actor: BackupActor): Promise<void> {
  const log = new StepLog(run.$id);
  const staging = dataPath(STAGING);
  const fileName = run.fileName!;
  let failure: string | null = null;
  let files: BackupFile[] = [];

  try {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(path.join(staging, 'data'), { recursive: true, mode: 0o700 });

    const dumped = await dumpDatabase(staging);
    await log.add('Datenbank herausgeschrieben', true, `${Math.max(1, Math.round(dumped / 1024))} KB`);

    fs.copyFileSync(dataPath('secrets.json'), path.join(staging, 'data', 'secrets.json'));
    await log.add('Schlüssel dazugelegt', true);

    const helper = await runHelper(run.hostPath, fileName, keep);
    files = parseBackupList(helper.output);
    const written = files.find((file) => file.name === fileName);
    if (helper.code !== 0 || !written) {
      const head = helper.output.split(LIST_MARK)[0].trim().slice(-600);
      await log.add('Archiv geschrieben', false, head || `Der Helfer endete mit Exit-Code ${helper.code}.`);
      throw new Error(`Das Archiv ließ sich nicht nach ${run.hostPath} schreiben.`);
    }
    await log.add('Archiv geschrieben', true, `${run.hostPath}/${fileName}`);
    await log.add(
      'Alte Sicherungen aufgeräumt',
      true,
      `${files.length} von höchstens ${keep} liegen im Ordner.`
    );

    await updateDocument<BackupRun>(BACKUP_RUNS, run.$id, {
      status: 'success',
      completedAt: new Date().toISOString(),
      sizeBytes: written.sizeBytes,
      files: JSON.stringify(files),
    });
  } catch (err) {
    failure = message(err);
    if (!log.steps.some((step) => !step.ok)) await log.add('Abbruch', false, failure);
    await updateDocument<BackupRun>(BACKUP_RUNS, run.$id, {
      status: 'error',
      completedAt: new Date().toISOString(),
      error: failure,
      files: files.length ? JSON.stringify(files) : null,
    }).catch(() => undefined);
  } finally {
    // Der herausgeschriebene Stand der Datenbank soll nicht im Volume liegen bleiben.
    fs.rmSync(staging, { recursive: true, force: true });
    globalLock.__hapmBackupRunning = false;
  }

  await logAudit({
    ...actor,
    action: failure ? 'backup_failed' : 'backup_completed',
    resource: 'backup',
    details: failure ? failure : `${run.hostPath}/${fileName}`,
  });
  if (failure) await onFailure(failure);
}

/** Wird von außen gesetzt, damit dieses Modul den Mailversand nicht kennen muss. */
let failureHook: ((detail: string) => Promise<void> | void) | null = null;

export function onBackupFailure(hook: (detail: string) => Promise<void> | void): void {
  failureHook = hook;
}

async function onFailure(detail: string): Promise<void> {
  try {
    await failureHook?.(detail);
  } catch {
    // Eine gescheiterte Benachrichtigung ändert am Ergebnis der Sicherung nichts.
  }
}

export async function startBackup(actor: BackupActor): Promise<BackupRun> {
  const settings = await getBackupSettings();
  if (!settings.hostPath) throw new ApiError('Es ist kein Ordner für die Sicherung eingestellt.');
  if (!ownContainer()) throw new ApiError('HAPM läuft nicht in einem Container. Die Sicherung braucht Docker.');
  if (globalLock.__hapmBackupRunning) throw new ApiError('Es läuft schon eine Sicherung.', 409);
  globalLock.__hapmBackupRunning = true;

  let run: BackupRun;
  try {
    run = await createDocument<BackupRun>(BACKUP_RUNS, {
      status: 'running',
      startedAt: new Date().toISOString(),
      completedAt: null,
      hostPath: settings.hostPath,
      fileName: backupFileName(new Date()),
      sizeBytes: null,
      files: null,
      steps: '[]',
      error: null,
      triggeredBy: actor.userEmail,
    });
  } catch (err) {
    globalLock.__hapmBackupRunning = false;
    throw err;
  }

  void execute(run, settings.keep, actor);
  return run;
}

export async function listBackupRuns(limit = 20): Promise<BackupRun[]> {
  return listDocuments<BackupRun>(BACKUP_RUNS, [Query.orderDesc('startedAt'), Query.limit(limit)]);
}

/** Beim Start: ein offener Lauf ist mit dem vorigen Prozess gestorben. */
export async function reconcileBackupRuns(): Promise<void> {
  const open = await listDocuments<BackupRun>(BACKUP_RUNS, [Query.equal('status', 'running'), Query.limit(20)]);
  for (const run of open) {
    await updateDocument<BackupRun>(BACKUP_RUNS, run.$id, {
      status: 'error',
      completedAt: new Date().toISOString(),
      error: 'HAPM wurde während der Sicherung neu gestartet.',
    });
  }
  fs.rmSync(dataPath(STAGING), { recursive: true, force: true });
}

export async function pruneBackupRuns(olderThanIso: string): Promise<number> {
  return deleteWhere(BACKUP_RUNS, [Query.lessThan('startedAt', olderThanIso)]);
}
