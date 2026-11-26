/**
 * Eine Sicherung zurückspielen, aus der Oberfläche.
 *
 * ── Der Ablauf ──
 *
 *  1. Bereitlegen: ein Archiv aus dem Sicherungsordner (ein Helfer kopiert es,
 *     HAPM sieht den Ordner nicht) oder hochgeladen (gestreamt, höchstens
 *     `RESTORE_MAX_BYTES`). Es liegt in `/data/.restore/archive.tar.gz`, immer
 *     höchstens eins, und wird sofort geprüft (`./archive.ts`). Ein Archiv,
 *     das die Prüfung nicht besteht, wird gleich wieder gelöscht.
 *     Ein verschlüsseltes Archiv (`./decrypt.ts`, erkannt am Inhalt) wird hier
 *     entschlüsselt, vor der Prüfung: zuerst mit dem gespeicherten
 *     Sicherungsschlüssel. Fehlt er oder passt er nicht (ein Archiv von einem
 *     anderen Server, ein inzwischen geänderter Schlüssel), bleibt die Datei
 *     als `archive.tar.gz.gpg` liegen, und die Seite fragt nach dem Schlüssel
 *     (`unlockStaged`). Ab dann ist alles wie bei einem unverschlüsselten.
 *  2. Starten (nach Bestätigung und Passwort): HAPM sichert den aktuellen Stand
 *     über den gewöhnlichen Weg (`writeArchive`). Scheitert das, wird nicht
 *     zurückgespielt. Die herausgeschriebene Datenbank bleibt als
 *     `before.sql` liegen, für den Fall, dass der Helfer zurückrollen muss.
 *  3. Übergabe: HAPM startet den Helfer `hapm-restore` aus dem eigenen Abbild,
 *     mit den Volumes von HAPM (schreibend) und damit dem Docker-Socket. Ein
 *     Prozess kann den Container, in dem er läuft, nicht anhalten und danach
 *     weiterarbeiten. Was der Helfer tut, steht in `./restore-script.ts`.
 *  4. Abschluss: der Helfer schreibt seinen Fortschritt in eine Datei, weil die
 *     Datenbank gerade ersetzt wird. Nach dem Neustart liest HAPM sie
 *     (`finalizeRestore`), trägt den Lauf in die zurückgespielte Datenbank ein
 *     (`restore_runs`, Protokoll), prüft den Schlüssel und räumt auf. Scheitert
 *     der Helfer, bevor er HAPM anhält, tut das der laufende Prozess.
 *
 * Schritte und Fehler stehen als deutscher Text im Lauf (`msgid`), die Seite
 * übersetzt sie. Ausgaben von Kommandos bleiben, wie sie sind.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { COLLECTIONS, createDocument, getDocument, listDocuments, updateDocument, Query } from '../db';
import { ApiError } from '../api';
import { msg, msgid } from '../i18n';
import { logAudit } from '../audit';
import { dataPath } from '../paths';
import { secrets } from '../secrets';
import { engine, ownContainer } from '../docker';
import type { DbDoc, HaproxyStep, RunStatus, UpdateRun } from '../types';
import { BACKUP_RUNS, getBackupSettings, passphraseState, readPassphrase } from './settings';
import { archiveFormat, decryptArchive } from './decrypt';
import {
  BACKUP_INTERRUPTED,
  BEFORE_RESTORE_DATA_FILE,
  BEFORE_RESTORE_SUFFIX,
  archiveNameFor,
  backupRunning,
  claimBackupLock,
  isBackupArchiveName,
  releaseBackupLock,
  writeArchive,
  type BackupActor,
  type BackupFile,
  type BackupRun,
  type BackupTarget,
} from './run';
import { ArchiveError, inspectArchive, type ArchiveCheck } from './archive';
import { hapmVersion, keyFingerprint } from './manifest';
import {
  NO_RESULT,
  RESTORE_FAILURES,
  RESTORE_SCRIPT,
  RESTORE_STEP_LABELS,
  ROLLBACK_INCOMPLETE,
  STAGE_SCRIPT,
  parseProgress,
  progressLine,
  type Progress,
  type RestoreStep,
} from './restore-script';

/**
 * Obergrenze für ein hochgeladenes Archiv. Eine Sicherung ist ein paar MB
 * Konfiguration, Zertifikate und acme.sh plus die Datenbank, und die wächst vor
 * allem mit der Statistik (14 Tage) und dem Protokoll. 512 MB lassen dafür das
 * Hundertfache Raum und halten trotzdem ab, dass ein falscher Upload die Platte
 * des Servers füllt. Gestreamt, nie im Speicher.
 */
export const RESTORE_MAX_BYTES = 512 * 1024 * 1024;

/** Der Name des Helfers: der von HAPM mit `-restore` dahinter, im Stack aus Compose also `hapm-restore`. */
export function restoreHelperName(ownName: string | null | undefined): string {
  return `${(ownName || 'hapm').replace(/^\//, '')}-restore`;
}
const DIR = '.restore';
const ARCHIVE = 'archive.tar.gz';
const PART = 'archive.tar.gz.part';
const META = 'archive.json';
/** Ein verschlüsseltes Archiv, das noch auf seinen Sicherungsschlüssel wartet, und was die Seite dazu zeigt. */
const LOCKED = 'archive.tar.gz.gpg';
const LOCKED_META = 'locked.json';
const STATE = 'state.json';
const PROGRESS = 'progress';
const BEFORE_SQL = 'before.sql';

export interface StagedArchive {
  /** Neu je Bereitlegen. Der Start nennt sie, damit genau das geprüfte Archiv zurückkommt. */
  id: string;
  source: 'folder' | 'upload';
  name: string;
  sizeBytes: number;
  stagedAt: string;
  stagedBy: string;
  /**
   * Womit das Archiv entschlüsselt wurde: mit dem gespeicherten
   * Sicherungsschlüssel oder mit einem eingegebenen. `null`: es war nicht
   * verschlüsselt. Fehlt bei einem Archiv, das eine ältere Fassung bereitgelegt hat.
   */
  unlockedWith?: 'stored' | 'entered' | null;
  check: ArchiveCheck;
}

/** Ein verschlüsseltes Archiv, das bereitliegt, aber noch nicht entschlüsselt und geprüft ist. */
export interface LockedArchive {
  id: string;
  source: 'folder' | 'upload';
  name: string;
  sizeBytes: number;
  stagedAt: string;
  stagedBy: string;
  /** Der gespeicherte Sicherungsschlüssel wurde versucht und passt nicht. */
  storedFailed: boolean;
}

interface RestoreState {
  runId: string;
  /** Der Name des Helfers, sobald er feststeht. */
  helper: string | null;
  startedAt: string;
  actor: BackupActor;
  archive: Pick<StagedArchive, 'source' | 'name' | 'sizeBytes'> & {
    version: string | null;
    createdAt: string | null;
    createdLocal: string | null;
  };
  expectedKeyFingerprint: string;
  /** Die Sicherung von unmittelbar vorher, sobald sie geschrieben ist. */
  beforeBackup: { location: string; hostLocation: string | null } | null;
  /** Ihr Lauf, wie er in `backup_runs` stünde. Die Datenbank, in der er stand, ist danach ersetzt. */
  beforeRun: Omit<BackupRun, keyof DbDoc> | null;
}

export interface RestoreRun extends DbDoc {
  status: RunStatus;
  startedAt: string;
  completedAt: string;
  source: 'folder' | 'upload';
  fileName: string;
  sizeBytes: number;
  archiveVersion: string | null;
  archiveCreatedAt: string | null;
  archiveCreatedLocal: string | null;
  /** Wo die Sicherung von unmittelbar vorher liegt, im Container bzw. im Ordner. */
  beforeBackup: string | null;
  /** Dieselbe Datei, wie man sie auf dem Server findet, falls bekannt. */
  beforeBackupHost: string | null;
  steps: string;
  error: string | null;
  triggeredBy: string;
}

const flags = globalThis as unknown as {
  __hapmRestoreRunning?: boolean;
  __hapmRestoreStaging?: boolean;
  __hapmRestoreFinalizing?: Promise<void> | null;
};

function dir(...parts: string[]): string {
  return dataPath(DIR, ...parts);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

function note(state: 'ok' | 'fail', step: RestoreStep, detail = ''): void {
  fs.appendFileSync(dir(PROGRESS), progressLine(state, step, detail), { mode: 0o600 });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readState(): RestoreState | null {
  return readJson<RestoreState>(dir(STATE));
}

function readProgress(): Progress {
  try {
    return parseProgress(fs.readFileSync(dir(PROGRESS), 'utf8'));
  } catch {
    return { steps: [], done: null };
  }
}

export function readStaged(): StagedArchive | null {
  const staged = readJson<StagedArchive>(dir(META));
  if (!staged || !fs.existsSync(dir(ARCHIVE))) return null;
  return staged;
}

export function readLocked(): LockedArchive | null {
  const locked = readJson<LockedArchive>(dir(LOCKED_META));
  if (!locked || !fs.existsSync(dir(LOCKED))) return null;
  return locked;
}

/** Alles, was vom Bereitlegen liegen kann. Nie mehr als ein Archiv, in welchem Zustand auch immer. */
function clearStaged(): void {
  for (const name of [ARCHIVE, PART, META, LOCKED, LOCKED_META]) fs.rmSync(dir(name), { force: true });
}

/** Ob gerade zurückgespielt wird: ein Lauf hat begonnen und hat noch kein Ergebnis. */
export function restoreActive(): boolean {
  return Boolean(flags.__hapmRestoreRunning) || (fs.existsSync(dir(STATE)) && !readProgress().done);
}

function requireDocker(): string {
  const own = ownContainer();
  if (!own) throw new ApiError(msg('HAPM läuft nicht in einem Container. Das Zurückspielen braucht Docker.'));
  return own;
}

function guardIdle(): void {
  if (restoreActive()) throw new ApiError(msg('Es läuft gerade ein Zurückspielen.'), 409);
  if (flags.__hapmRestoreStaging) throw new ApiError(msg('Es wird gerade ein Archiv bereitgelegt.'), 409);
}

/** Das bereitgelegte Archiv verwerfen. Nicht, solange es zurückgespielt wird. */
export function discardStaged(): boolean {
  guardIdle();
  const had = [ARCHIVE, META, LOCKED, LOCKED_META].some((name) => fs.existsSync(dir(name)));
  clearStaged();
  return had;
}

/** Ein Name für die Anzeige: ohne Pfad, ohne Steuerzeichen, nicht beliebig lang. */
export function displayName(raw: string | null): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return clean || 'archiv.tar.gz';
}

async function inspectStaged(
  source: StagedArchive['source'],
  name: string,
  sizeBytes: number,
  actor: BackupActor,
  unlockedWith: StagedArchive['unlockedWith'] = null
): Promise<StagedArchive> {
  let check: ArchiveCheck;
  try {
    check = await inspectArchive(dir(ARCHIVE), {
      name,
      currentVersion: hapmVersion(),
      envKey: process.env.ENCRYPTION_KEY || null,
    });
  } catch (err) {
    fs.rmSync(dir(ARCHIVE), { force: true });
    if (err instanceof ArchiveError) {
      if (err.detail) console.log(`[restore] Archiv ${name} abgelehnt: ${err.detail}`);
      throw new ApiError(err.reason);
    }
    throw err;
  }
  const staged: StagedArchive = {
    id: randomUUID(),
    source,
    name,
    sizeBytes,
    stagedAt: new Date().toISOString(),
    stagedBy: actor.userEmail,
    unlockedWith,
    check,
  };
  writeJson(dir(META), staged);
  return staged;
}

const DAMAGED = msgid('Das Archiv lässt sich nicht entschlüsseln. Es ist beschädigt, unvollständig oder nicht mit gpg verschlüsselt.');
const NO_GPG = msgid('gpg fehlt in diesem Container. Ein verschlüsseltes Archiv lässt sich hier nicht entschlüsseln.');

/** Der gespeicherte Sicherungsschlüssel. `null`, wenn keiner gesetzt oder er nicht lesbar ist: dann fragt die Seite. */
async function storedPassphrase(): Promise<string | null> {
  try {
    return readPassphrase(await getBackupSettings());
  } catch {
    return null;
  }
}

/**
 * Entschlüsselt das wartende Archiv nach `ARCHIVE`. `false`: der Schlüssel
 * passt nicht, das Archiv wartet weiter. Alles andere wirft, und das Archiv ist
 * dann weg: ein beschädigtes entschlüsselt auch der richtige Schlüssel nicht.
 */
async function decryptLocked(passphrase: string, name: string): Promise<boolean> {
  const { result, detail } = await decryptArchive(dir(LOCKED), dir(ARCHIVE), passphrase);
  if (result === 'wrong-passphrase') return false;
  if (result === 'ok') {
    for (const file of [LOCKED, LOCKED_META]) fs.rmSync(dir(file), { force: true });
    return true;
  }
  clearStaged();
  if (detail) console.log(`[restore] Archiv ${name} ließ sich nicht entschlüsseln: ${detail}`);
  throw new ApiError(result === 'unavailable' ? NO_GPG : DAMAGED);
}

/**
 * Das Archiv liegt als `ARCHIVE` da: prüfen, und vorher entschlüsseln, falls
 * nötig. Gibt das geprüfte Archiv zurück, oder das wartende, wenn der
 * Sicherungsschlüssel fehlt.
 */
async function admit(
  source: StagedArchive['source'],
  name: string,
  sizeBytes: number,
  actor: BackupActor
): Promise<StagedArchive | LockedArchive> {
  if (archiveFormat(dir(ARCHIVE)) !== 'gpg') return inspectStaged(source, name, sizeBytes, actor);

  fs.renameSync(dir(ARCHIVE), dir(LOCKED));
  const stored = await storedPassphrase();
  if (stored !== null && (await decryptLocked(stored, name))) {
    return inspectStaged(source, name, sizeBytes, actor, 'stored');
  }
  const locked: LockedArchive = {
    id: randomUUID(),
    source,
    name,
    sizeBytes,
    stagedAt: new Date().toISOString(),
    stagedBy: actor.userEmail,
    storedFailed: stored !== null,
  };
  writeJson(dir(LOCKED_META), locked);
  return locked;
}

/**
 * Das wartende Archiv mit einem eingegebenen Sicherungsschlüssel entschlüsseln
 * und prüfen. Geprüft wird die Eingabe nur so weit, wie gpg sie als eine Zeile
 * lesen muss: die Regeln aus `./passphrase.ts` gelten für Schlüssel, die HAPM
 * speichert, nicht für einen, mit dem jemand von Hand verschlüsselt hat.
 */
export async function unlockStaged(id: unknown, passphrase: unknown, actor: BackupActor): Promise<StagedArchive> {
  requireDocker();
  guardIdle();
  const locked = readLocked();
  if (!locked || typeof id !== 'string' || locked.id !== id) {
    throw new ApiError(msg('Das verschlüsselte Archiv liegt nicht mehr bereit. Bitte wählen Sie es erneut.'), 409);
  }
  if (typeof passphrase !== 'string' || passphrase === '') throw new ApiError(msg('Der Sicherungsschlüssel fehlt.'));
  if (passphrase.length > 1000 || /[\u0000-\u001f\u007f]/.test(passphrase)) {
    throw new ApiError(msg('Der Sicherungsschlüssel passt nicht zu diesem Archiv.'));
  }
  flags.__hapmRestoreStaging = true;
  try {
    if (!(await decryptLocked(passphrase, locked.name))) {
      throw new ApiError(msg('Der Sicherungsschlüssel passt nicht zu diesem Archiv.'));
    }
    return await inspectStaged(locked.source, locked.name, locked.sizeBytes, actor, 'entered');
  } finally {
    flags.__hapmRestoreStaging = false;
  }
}

class TooLarge extends Error {}

/** Ein hochgeladenes Archiv auf die Platte, gestreamt, mit Obergrenze. */
export async function stageUpload(
  body: ReadableStream<Uint8Array> | null,
  rawName: string | null,
  actor: BackupActor
): Promise<StagedArchive | LockedArchive> {
  requireDocker();
  guardIdle();
  if (!body) throw new ApiError(msg('Es kam keine Datei an.'));
  flags.__hapmRestoreStaging = true;
  try {
    fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
    clearStaged();
    let size = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > RESTORE_MAX_BYTES) callback(new TooLarge());
        else callback(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(body as unknown as WebReadableStream<Uint8Array>),
        limit,
        fs.createWriteStream(dir(PART), { mode: 0o600 })
      );
    } catch (err) {
      fs.rmSync(dir(PART), { force: true });
      if (err instanceof TooLarge) {
        throw new ApiError(msg('Das Archiv ist größer als {max}. So groß wird eine Sicherung von HAPM nicht.', { max: '512 MB' }), 413);
      }
      throw new ApiError(msg('Die Datei kam nicht vollständig an.'));
    }
    if (size === 0) {
      fs.rmSync(dir(PART), { force: true });
      throw new ApiError(msg('Die Datei ist leer.'));
    }
    fs.renameSync(dir(PART), dir(ARCHIVE));
    return await admit('upload', displayName(rawName), size, actor);
  } finally {
    flags.__hapmRestoreStaging = false;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any -- Antworten der Engine */

/** Ein Archiv aus dem Sicherungsordner bereitlegen. */
export async function stageFromFolder(name: string, actor: BackupActor): Promise<StagedArchive | LockedArchive> {
  const own = requireDocker();
  if (!isBackupArchiveName(name)) throw new ApiError(msg('Das ist kein Name eines Archivs von HAPM.'));
  const settings = await getBackupSettings();
  if (!settings.hostPath) throw new ApiError(msg('Es ist kein Ordner für die Sicherung eingestellt.'));
  guardIdle();
  flags.__hapmRestoreStaging = true;
  try {
    fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
    clearStaged();

    const self: any = await engine.inspectContainer(own);
    const helper = `hapm-restore-stage-${Date.now()}`;
    await engine.createContainer(helper, {
      Image: self.Image,
      Entrypoint: ['sh', '-c'],
      Cmd: [STAGE_SCRIPT],
      Env: [`RESTORE_NAME=${name}`],
      User: 'root',
      Healthcheck: { Test: ['NONE'] },
      HostConfig: {
        // Schreibend nur, weil das Archiv in den Daten-Ordner muss. Der Ordner mit den Sicherungen bleibt lesend.
        VolumesFrom: [self.Id],
        Binds: [`${settings.hostPath}:/backup:ro`],
        NetworkMode: 'none',
      },
    });
    let code: number;
    let output = '';
    try {
      await engine.start(helper);
      code = await engine.wait(helper, 10 * 60 * 1000);
      output = await engine.logs(helper, { tail: 50 }).catch(() => '');
    } finally {
      await engine.removeContainer(helper, { force: true }).catch(() => undefined);
    }
    const size = fs.statSync(dir(ARCHIVE), { throwIfNoEntry: false })?.size;
    if (code !== 0 || size === undefined) {
      if (/No such file/i.test(output)) {
        throw new ApiError(msg('{name} liegt nicht mehr in {path}.', { name, path: settings.hostPath }));
      }
      console.log(`[restore] ${name} ließ sich nicht holen: ${output.trim().slice(-400)}`);
      throw new ApiError(msg('Das Archiv ließ sich nicht aus dem Ordner holen.'));
    }
    return await admit('folder', name, size, actor);
  } finally {
    flags.__hapmRestoreStaging = false;
  }
}

/** Wo eine Datei im Daten-Ordner auf dem Server liegt. `null` bei einem Volume ohne bekannten Pfad. */
async function hostPathOfData(own: string, file: string): Promise<string | null> {
  const self: any = await engine.inspectContainer(own).catch(() => null);
  const mount = (self?.Mounts ?? []).find((entry: any) => entry.Destination === '/data');
  return mount?.Source ? `${mount.Source}/${file}` : null;
}

async function updateRunning(): Promise<boolean> {
  const updateLock = globalThis as unknown as { __hapmUpdateRunning?: boolean };
  if (updateLock.__hapmUpdateRunning) return true;
  const open = await listDocuments<UpdateRun>(COLLECTIONS.UPDATE_RUNS, [Query.equal('status', 'running'), Query.limit(1)]);
  return open.length > 0;
}

export interface PreparedRestore {
  staged: StagedArchive;
  own: string;
}

/**
 * Alles prüfen, was gegen den Start spricht, und die Sperren nehmen. Danach
 * steht der Lauf fest, `beginRestore` startet ihn.
 */
export async function prepareRestore(id: unknown): Promise<PreparedRestore> {
  const own = requireDocker();
  const staged = readStaged();
  if (!staged || typeof id !== 'string' || staged.id !== id) {
    throw new ApiError(msg('Das geprüfte Archiv liegt nicht mehr bereit. Bitte wählen Sie es erneut.'), 409);
  }
  if (staged.check.blockers.length > 0) {
    throw new ApiError(msg('Dieses Archiv lässt sich so nicht zurückspielen. Die Gründe stehen bei der Prüfung.'));
  }
  guardIdle();
  if (await updateRunning()) throw new ApiError(msg('Es läuft gerade ein Update. Bitte warten, bis es fertig ist.'), 409);
  if (!claimBackupLock()) throw new ApiError(msg('Es läuft gerade eine Sicherung. Bitte warten, bis sie fertig ist.'), 409);
  flags.__hapmRestoreRunning = true;
  return { staged, own };
}

export function beginRestore(prepared: PreparedRestore, actor: BackupActor): { runId: string } {
  const { staged } = prepared;
  const state: RestoreState = {
    runId: randomUUID(),
    helper: null,
    startedAt: new Date().toISOString(),
    actor,
    archive: {
      source: staged.source,
      name: staged.name,
      sizeBytes: staged.sizeBytes,
      version: staged.check.version,
      createdAt: staged.check.createdAt,
      createdLocal: staged.check.createdLocal,
    },
    expectedKeyFingerprint: staged.check.effectiveKeyFingerprint,
    beforeBackup: null,
    beforeRun: null,
  };
  try {
    fs.rmSync(dir(PROGRESS), { force: true });
    fs.rmSync(dir(BEFORE_SQL), { force: true });
    writeJson(dir(STATE), state);
  } catch (err) {
    flags.__hapmRestoreRunning = false;
    releaseBackupLock();
    throw err;
  }
  void execute(state, prepared.own);
  return { runId: state.runId };
}

async function execute(state: RestoreState, own: string): Promise<void> {
  // 1. Der aktuelle Stand, über den gewöhnlichen Weg.
  try {
    const settings = await getBackupSettings();
    const now = new Date();
    const target: BackupTarget = settings.hostPath
      ? { kind: 'folder', hostPath: settings.hostPath, keep: settings.keep, prune: false }
      : { kind: 'data' };
    // Im Ordner gilt der Sicherungsschlüssel wie für jede Sicherung, und zwar
    // der jetzt gespeicherte: nach dem Zurückspielen steht in der Datenbank der
    // aus dem Archiv. Im Daten-Ordner wird nicht verschlüsselt, dort liegt
    // `secrets.json` im Klartext daneben.
    const { fileName, passphrase } = settings.hostPath
      ? await archiveNameFor(now, BEFORE_RESTORE_SUFFIX)
      : { fileName: BEFORE_RESTORE_DATA_FILE, passphrase: null };
    const steps: HaproxyStep[] = [];
    const written = await writeArchive({
      target,
      fileName,
      passphrase,
      kind: 'before-restore',
      keepDumpAt: dir(BEFORE_SQL),
      onStep: async (label, ok, detail) => {
        steps.push({ label, ok, ...(detail ? { detail } : {}) });
      },
    });
    state.beforeBackup = {
      location: written.location,
      hostLocation: target.kind === 'folder' ? written.location : await hostPathOfData(own, fileName),
    };
    if (target.kind === 'folder') {
      state.beforeRun = {
        status: 'success',
        startedAt: now.toISOString(),
        completedAt: new Date().toISOString(),
        hostPath: target.hostPath,
        fileName,
        encrypted: passphrase !== null,
        sizeBytes: written.sizeBytes,
        files: JSON.stringify(written.files),
        steps: JSON.stringify(steps),
        error: null,
        triggeredBy: state.actor.userEmail,
      };
    }
    writeJson(dir(STATE), state);
    note('ok', 'backup', state.beforeBackup.hostLocation ?? state.beforeBackup.location);
  } catch (err) {
    note('fail', 'backup', message(err));
    fs.appendFileSync(dir(PROGRESS), 'done error backup\n');
    releaseBackupLock();
    await finalizeRestore().catch((e) => console.error('[restore]', e));
    return;
  }
  releaseBackupLock();

  // 2. Übergabe an den Helfer. Er hält diesen Container an.
  try {
    const self: any = await engine.inspectContainer(own);
    const helper = restoreHelperName(self.Name);
    state.helper = helper;
    writeJson(dir(STATE), state);
    const stale = await engine.findContainer(helper);
    if (stale) await engine.removeContainer(helper, { force: true });
    await engine.createContainer(helper, {
      Image: self.Image,
      Entrypoint: ['sh', '-c'],
      Cmd: [RESTORE_SCRIPT],
      Env: [
        // Dieselben Namen der Container und der Datenbank wie HAPM.
        ...((self.Config?.Env ?? []) as string[]).filter((entry) => !entry.startsWith('RESTORE_')),
        `RESTORE_HAPM=${self.Id}`,
        'HAPM_BOOTSTRAP=0',
      ],
      User: 'root',
      Healthcheck: { Test: ['NONE'] },
      HostConfig: {
        // Alle Volumes von HAPM, schreibend, und darin der Docker-Socket.
        VolumesFrom: [self.Id],
        NetworkMode: 'none',
      },
    });
    await engine.start(helper);
    note('ok', 'handover', msgid('Der Helfer hält HAPM jetzt an und spielt die Sicherung zurück. HAPM ist gleich wieder da.'));
  } catch (err) {
    note('fail', 'handover', message(err));
    fs.appendFileSync(dir(PROGRESS), 'done error handover\n');
    await finalizeRestore().catch((e) => console.error('[restore]', e));
  }
}

/* eslint-enable @typescript-eslint/no-explicit-any */

async function helperRunning(name: string | null): Promise<boolean> {
  if (!name) return false;
  const helper = (await engine.findContainer(name).catch(() => null)) as { State?: { Running?: boolean } } | null;
  return Boolean(helper?.State?.Running);
}

/** Der Fortschritt als Schritte eines Laufs, mit den Beschriftungen der Seite. */
function toSteps(progress: Progress): HaproxyStep[] {
  return progress.steps.map((line) => ({
    label: RESTORE_STEP_LABELS[line.step as RestoreStep] ?? line.step,
    ok: line.ok,
    ...(line.detail ? { detail: line.detail } : {}),
  }));
}

/**
 * Den Lauf abschließen, wenn er ein Ergebnis hat oder sein Helfer ohne eines
 * verschwunden ist: in die Datenbank, ins Protokoll, aufräumen. Läuft nach
 * dem Start von HAPM und bei jeder Abfrage der Seite. Doppelt aufgerufen tut
 * es nichts doppelt.
 */
export function finalizeRestore(): Promise<void> {
  flags.__hapmRestoreFinalizing ??= doFinalize().finally(() => {
    flags.__hapmRestoreFinalizing = null;
  });
  return flags.__hapmRestoreFinalizing;
}

async function doFinalize(): Promise<void> {
  const state = readState();
  if (!state) return;
  const progress = readProgress();
  if (!progress.done) {
    if (flags.__hapmRestoreRunning || (await helperRunning(state.helper))) return;
  }

  const steps = toSteps(progress);
  const names = new Set(progress.steps.map((line) => line.step));
  const succeeded = progress.done?.status === 'success';
  const helperReached = names.has('prepare');
  let status: RunStatus = succeeded ? 'success' : 'error';
  let error: string | null = null;

  if (!progress.done) {
    error = NO_RESULT;
  } else if (!succeeded) {
    const failedStep = (progress.done.step ?? '') as RestoreStep;
    error = RESTORE_FAILURES[failedStep] ?? NO_RESULT;
    if (progress.steps.some((line) => line.step.startsWith('rollback_') && !line.ok)) error = ROLLBACK_INCOMPLETE;
  }

  // Wer das hier liest, läuft: der Neustart hat geklappt, auch wenn die Zeile dazu noch fehlt.
  if (helperReached && names.has('stop') && !names.has('start')) {
    steps.push({ label: RESTORE_STEP_LABELS.start, ok: true });
  }

  if (succeeded) {
    const running = keyFingerprint(secrets().encryptionKey);
    const fromEnvironment = Boolean(process.env.ENCRYPTION_KEY);
    const keyOk = running === state.expectedKeyFingerprint;
    steps.push({
      label: RESTORE_STEP_LABELS.key,
      ok: keyOk,
      detail: keyOk
        ? fromEnvironment
          ? msgid('HAPM läuft mit ENCRYPTION_KEY aus der Umgebung, und er passt zur Sicherung.')
          : msgid('HAPM läuft mit dem Schlüssel aus der Sicherung.')
        : msgid('HAPM läuft nicht mit dem Schlüssel, den die Prüfung erwartet hat. Verschlüsselte Werte sind womöglich nicht lesbar.'),
    });
    if (!keyOk) {
      status = 'warning';
      error = msgid('Zurückgespielt, aber HAPM läuft nicht mit dem erwarteten Schlüssel. Zweiter Faktor, DNS-Tokens und SMTP-Passwort sind womöglich nicht lesbar.');
    }
  }

  const completedAt = new Date().toISOString();
  const run: Omit<RestoreRun, keyof DbDoc> = {
    status,
    startedAt: state.startedAt,
    completedAt,
    source: state.archive.source,
    fileName: state.archive.name,
    sizeBytes: state.archive.sizeBytes,
    archiveVersion: state.archive.version,
    archiveCreatedAt: state.archive.createdAt,
    archiveCreatedLocal: state.archive.createdLocal,
    beforeBackup: state.beforeBackup?.location ?? null,
    beforeBackupHost: state.beforeBackup?.hostLocation ?? null,
    steps: JSON.stringify(steps),
    error,
    triggeredBy: state.actor.userEmail,
  };

  const exists = await getDocument<RestoreRun>(COLLECTIONS.RESTORE_RUNS, state.runId).catch(() => null);
  if (!exists) {
    await createDocument<RestoreRun>(COLLECTIONS.RESTORE_RUNS, run, state.runId);
    // Die Sicherung von vorher stand in der Datenbank, die jetzt ersetzt ist.
    if (state.beforeRun) {
      await createDocument<BackupRun>(BACKUP_RUNS, state.beforeRun).catch(() => undefined);
    }
    if (succeeded) await settleArchiveRun(state.archive.name, state.archive.sizeBytes).catch(() => undefined);
    await logAudit({
      ...state.actor,
      action: status === 'error' ? 'backup_restore_failed' : 'backup_restore_completed',
      resource: 'backup',
      resourceId: state.runId,
      details:
        `${state.archive.name}: ${status === 'error' ? (error ?? 'gescheitert') : 'zurückgespielt'}` +
        (state.beforeBackup ? `. Vorher gesichert nach ${state.beforeBackup.hostLocation ?? state.beforeBackup.location}` : ''),
    });
  }

  if (state.helper) {
    const helper = (await engine.findContainer(state.helper).catch(() => null)) as { State?: { Running?: boolean } } | null;
    if (helper && !helper.State?.Running) await engine.removeContainer(state.helper, { force: true }).catch(() => undefined);
  }
  fs.rmSync(dir(), { recursive: true, force: true });
  flags.__hapmRestoreRunning = false;
}

/**
 * Der Lauf, der das zurückgespielte Archiv geschrieben hat. `pg_dump` lief
 * mitten in ihm, in der Datenbank steht er also als laufend, und beim Start hat
 * `reconcileBackupRuns` ihn eben als abgebrochen geschlossen. Das Archiv ist
 * aber vollständig, es wurde gerade zurückgespielt: der Lauf ist gelungen.
 */
async function settleArchiveRun(fileName: string, sizeBytes: number): Promise<void> {
  const runs = await listDocuments<BackupRun>(BACKUP_RUNS, [Query.equal('fileName', fileName), Query.limit(5)]);
  for (const run of runs) {
    if (run.status !== 'running' && !(run.status === 'error' && run.error === BACKUP_INTERRUPTED)) continue;
    const steps = JSON.parse(run.steps ?? '[]') as HaproxyStep[];
    steps.push({
      label: msgid('Archiv geschrieben'),
      ok: true,
      detail: msgid('Die Datenbank im Archiv stammt aus der Mitte dieses Laufs. Das Archiv ist vollständig und wurde zurückgespielt.'),
    });
    await updateDocument<BackupRun>(BACKUP_RUNS, run.$id, {
      status: 'success',
      error: null,
      sizeBytes: run.sizeBytes ?? sizeBytes,
      completedAt: run.completedAt ?? run.startedAt,
      steps: JSON.stringify(steps),
    });
  }
}

/** Beim Start: was der vorige Prozess oder der Helfer offen gelassen hat. */
export async function reconcileRestore(): Promise<void> {
  if (!fs.existsSync(dir(STATE))) {
    // Ein Bereitlegen, das mit dem vorigen Prozess gestorben ist.
    fs.rmSync(dir(PART), { force: true });
    return;
  }
  await finalizeRestore();
}

export async function listRestoreRuns(limit = 5): Promise<RestoreRun[]> {
  return listDocuments<RestoreRun>(COLLECTIONS.RESTORE_RUNS, [Query.orderDesc('startedAt'), Query.limit(limit)]);
}

/** Was die Seite braucht: das bereitgelegte Archiv, ein laufendes Zurückspielen, die letzten Läufe. */
export async function restoreOverview() {
  await finalizeRestore().catch((err) => console.error('[restore]', err));
  const state = readState();
  const progress = readProgress();
  const settings = await getBackupSettings();
  const own = ownContainer();
  return {
    available: own !== null,
    maxBytes: RESTORE_MAX_BYTES,
    staged: readStaged(),
    /** Ein verschlüsseltes Archiv, das auf seinen Sicherungsschlüssel wartet. Nie zugleich mit `staged`. */
    locked: readLocked(),
    active: state
      ? {
          runId: state.runId,
          startedAt: state.startedAt,
          archive: state.archive,
          beforeBackup: state.beforeBackup,
          steps: toSteps(progress),
          done: progress.done,
        }
      : null,
    /** Wohin die Sicherung von vorher geht, und ob sie mit dem jetzt gespeicherten Sicherungsschlüssel verschlüsselt wird. */
    beforeTarget: settings.hostPath
      ? { kind: 'folder' as const, path: settings.hostPath, encrypted: passphraseState(settings).encrypted }
      : {
          kind: 'data' as const,
          path: (own ? await hostPathOfData(own, BEFORE_RESTORE_DATA_FILE) : null) ?? dataPath(BEFORE_RESTORE_DATA_FILE),
          encrypted: false,
        },
    busy: backupRunning() || Boolean(flags.__hapmRestoreStaging),
    runs: await listRestoreRuns(),
  };
}

export type RestoreOverview = Awaited<ReturnType<typeof restoreOverview>>;
export type { BackupFile };

/** Das laufende Zurückspielen für die Pille unten rechts, ohne den Rest der Übersicht. */
export function activeRestore(): { runId: string; startedAt: string; name: string } | null {
  const state = readState();
  if (!state || readProgress().done) return null;
  return { runId: state.runId, startedAt: state.startedAt, name: state.archive.name };
}

/**
 * Ein Lauf für das Fenster der Läufe: solange er läuft aus der Datei des
 * Fortschritts, danach aus der Datenbank. `null`, wenn es ihn nicht gibt.
 */
export async function restoreRunView(runId: string) {
  await finalizeRestore().catch((err) => console.error('[restore]', err));
  const state = readState();
  if (state?.runId === runId) {
    return {
      $id: runId,
      status: 'running' as RunStatus,
      startedAt: state.startedAt,
      completedAt: null,
      fileName: state.archive.name,
      steps: toSteps(readProgress()),
      error: null,
    };
  }
  const run = await getDocument<RestoreRun>(COLLECTIONS.RESTORE_RUNS, runId).catch(() => null);
  if (!run) return null;
  return {
    $id: run.$id,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt as string | null,
    fileName: run.fileName,
    steps: JSON.parse(run.steps || '[]') as HaproxyStep[],
    error: run.error,
  };
}
