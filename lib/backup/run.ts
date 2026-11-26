/**
 * Die Sicherung: ein Archiv mit allem, was diese Installation ausmacht, in einem
 * Ordner auf dem Server.
 *
 * Im Archiv:
 *  - `manifest.json`  Fassung von HAPM, Zeitpunkt, Fingerabdruck des Schlüssels
 *                     (`./manifest.ts`, seit 0.5)
 *  - `database.sql`   die Datenbank von HAPM (Konten, Einstellungen, Historie)
 *  - `data/`          `secrets.json`, der Schlüssel zu den verschlüsselten Werten
 *  - `haproxy/`       `/etc/haproxy`: Konfiguration, Zertifikate, Fehlerseiten
 *  - `.acme.sh/`      acme.sh mit Konto, Zertifikaten und Erneuerungseinträgen
 *
 * Nicht im Archiv: das Log von HAProxy und die Abbilder.
 *
 * Mit einem Sicherungsschlüssel (`./passphrase.ts`) verschlüsselt der Helfer
 * das Archiv, während er es schreibt: `tar` reicht an `gpg` weiter, die Datei
 * heißt `….tar.gz.gpg`, und im Ordner liegt zu keinem Zeitpunkt ein Archiv im
 * Klartext. Der Ordner ist oft ein Netzlaufwerk, dafür ist die Verschlüsselung da.
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
 * Die Sicherung vor dem Zurückspielen (`./restore.ts`) geht denselben Weg. Ohne
 * eingestellten Ordner schreibt der Helfer sie in den Daten-Ordner, dafür
 * bekommt er die Volumes dann schreibend.
 *
 * ── Warum die Datenbank vorher herausgeschrieben wird ──
 *
 * Die Dateien einer laufenden Datenbank zu kopieren ergibt ein Archiv, das sich
 * vielleicht nicht mehr öffnen lässt. `pg_dump` schreibt einen stimmigen Stand.
 * Er läuft im Postgres-Container, sein Ergebnis kommt in einen Zwischenordner
 * im Daten-Volume, und von dort nimmt es der Helfer.
 *
 * Schritte und Fehler stehen als deutscher Text im Lauf. Was keine Werte
 * einsetzt, ist ein Schlüssel (`msgid`), den die Seite übersetzt. Texte mit
 * Werten bleiben deutsch (docs/i18n.md).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createDocument, deleteWhere, getDocument, listDocuments, updateDocument, Query } from '../db';
import { ApiError } from '../api';
import { msg, msgid } from '../i18n';
import { logAudit } from '../audit';
import { dataPath } from '../paths';
import { secrets } from '../secrets';
import { engine, ownContainer } from '../docker';
import type { DbDoc, HaproxyStep, RunStatus } from '../types';
import { BACKUP_RUNS, getBackupSettings, readPassphrase } from './settings';
import { MANIFEST_NAME, buildManifest, type BackupKind } from './manifest';
import { ENCRYPTED_SUFFIX, isEncryptedName } from './passphrase';

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
  /** Mit dem Sicherungsschlüssel verschlüsselt. Fehlt bei älteren Läufen: die waren es nie. */
  encrypted?: boolean;
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

/**
 * Wohin ein Archiv geht: in den eingestellten Ordner auf dem Server, oder,
 * nur vor dem Zurückspielen und ohne Ordner, in den Daten-Ordner von HAPM.
 */
export type BackupTarget =
  | { kind: 'folder'; hostPath: string; keep: number; prune: boolean }
  | { kind: 'data' };

export interface WrittenArchive {
  /** Wo das Archiv liegt, so wie man es auf dem Server bzw. im Container findet. */
  location: string;
  fileName: string;
  sizeBytes: number;
  /** Was danach im Ordner liegt. Leer beim Daten-Ordner. */
  files: BackupFile[];
}

const STAGING = '.backup-staging';
/**
 * Der Sicherungsschlüssel für den Helfer, als Datei im Daten-Ordner (600), nur
 * für die Dauer eines Laufs. Nicht in der Umgebung des Helfers: die zeigt
 * `docker inspect` jedem, der an Docker kommt. Der Helfer liest den
 * Daten-Ordner ohnehin (nur lesend). Die Datei liegt neben `secrets.json`, mit
 * dem sich der gespeicherte Schlüssel lesen lässt: sie verrät dort nichts, was
 * nicht schon da liegt.
 */
const KEY_FILE = '.backup-passphrase';
const LIST_MARK = '---HAPM-BACKUP-LIST---';
const HELPER_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Die Sicherung unmittelbar vor dem Zurückspielen. Der Zusatz hält sie aus der
 * Aufbewahrung heraus: das Aufräumen nimmt nur Namen ohne ihn, sie bleibt also
 * liegen, bis jemand sie löscht. Sonst wäre ausgerechnet der Stand vor dem
 * Zurückspielen, als ältester mit Zeitstempel, der erste, der weggeräumt wird.
 */
export const BEFORE_RESTORE_SUFFIX = '-vor-ruecksicherung';
/** Ohne eingestellten Ordner: eine Datei im Daten-Ordner, die vorige wird ersetzt. */
export const BEFORE_RESTORE_DATA_FILE = 'hapm-before-restore.tar.gz';

const ARCHIVE_NAME = /^hapm-backup-\d{8}-\d{6}(?:-vor-ruecksicherung)?\.tar\.gz(?:\.gpg)?$/;

/** Ein Archiv von HAPM im Ordner, mit oder ohne Zusatz, verschlüsselt oder nicht. */
export function isBackupArchiveName(name: string): boolean {
  return ARCHIVE_NAME.test(name);
}

const globalLock = globalThis as unknown as { __hapmBackupRunning?: boolean };

export function backupRunning(): boolean {
  return Boolean(globalLock.__hapmBackupRunning);
}

/** Die Sperre, die auch das Zurückspielen für seine Sicherung nimmt. `false`, wenn sie schon vergeben ist. */
export function claimBackupLock(): boolean {
  if (globalLock.__hapmBackupRunning) return false;
  globalLock.__hapmBackupRunning = true;
  return true;
}

export function releaseBackupLock(): void {
  globalLock.__hapmBackupRunning = false;
}

function postgresContainer(): string {
  return process.env.HAPM_POSTGRES_CONTAINER || 'hapm-postgres';
}

/**
 * `hapm-backup-20261124-023000.tar.gz`: der Zeitpunkt sortiert die Archive.
 * Verschlüsselt mit `.gpg` dahinter, wie gpg selbst die Datei nennen würde.
 */
export function backupFileName(now: Date, suffix = '', encrypted = false): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `hapm-backup-${stamp}${suffix}.tar.gz${encrypted ? ENCRYPTED_SUFFIX : ''}`;
}

/**
 * Wie gpg verschlüsselt. An einer Stelle, weil der Helfer, die Tests und
 * `docs/betrieb.md` dasselbe meinen müssen.
 *
 *  - `--symmetric --cipher-algo AES256`: nur der Sicherungsschlüssel, kein
 *    Schlüsselpaar. gpg schützt die Daten dabei gegen Veränderung (MDC) und
 *    endet beim Entschlüsseln mit einem Fehler, wenn etwas nicht stimmt.
 *  - `--s2k-*`: aus dem Sicherungsschlüssel wird der AES-Schlüssel mit SHA-512
 *    und der höchsten Zahl an Runden abgeleitet, die OpenPGP kennt. Das bremst
 *    das Durchprobieren, mehr nicht: ein kurzer Schlüssel bleibt ein kurzer.
 *  - `--compress-algo none`: das Archiv ist schon gzip.
 *  - `--batch --no-tty --pinentry-mode loopback`: ohne Rückfrage und ohne
 *    Terminal. Der Schlüssel kommt über `--passphrase-file` aus einer Datei und
 *    nie als Argument (das stünde in `ps`).
 *  - `--no-symkey-cache`: gpg fragt keinen gpg-agent. Im Abbild liegt nur
 *    `gpg`, kein Agent, und ein Helfer soll keinen Dienst starten.
 *  - `--no-keyring`: es gibt kein Schlüsselpaar, also legt gpg auch keinen
 *    Schlüsselbund an.
 *
 * Dazu je Lauf `--homedir` auf einen leeren Ordner: ohne ihn legt gpg seine
 * Dateien in `~/.gnupg` an und scheitert, wenn es das nicht darf.
 */
export const GPG_ENCRYPT_FLAGS =
  '--batch --yes --no-tty --quiet --no-symkey-cache --no-keyring --pinentry-mode loopback ' +
  '--symmetric --cipher-algo AES256 --s2k-mode 3 --s2k-digest-algo SHA512 --s2k-count 65011712 --compress-algo none';

/**
 * Was der Helfer ausführt. Fester Text: Name, Anzahl und Ziel kommen über die
 * Umgebung herein und nie in den Text, der Ordner ist eine Einbindung.
 *
 * Geschrieben wird unter einem vorläufigen Namen und erst danach umbenannt: ein
 * abgebrochener Lauf hinterlässt so kein Archiv, das wie ein fertiges aussieht
 * und als jüngstes ein gutes verdrängt.
 *
 * Mit `BACKUP_ENCRYPT=1` geht die Ausgabe von tar durch gpg, der
 * Sicherungsschlüssel kommt aus der Datei `BACKUP_KEY_FILE`. Dafür bash und
 * `pipefail`: scheitert tar, soll kein halbes Archiv als gelungen gelten, nur
 * weil gpg das Wenige sauber verschlüsselt hat. Eine leere Datei wird
 * abgelehnt, sonst verschlüsselte gpg mit einem leeren Schlüssel.
 *
 * Aufgeräumt werden nur Namen ohne Zusatz, verschlüsselte und unverschlüsselte
 * zählen zusammen. Die Liste am Ende nennt alle. `|| true` hinter grep, weil
 * mit `pipefail` ein Ordner ohne Treffer sonst den Lauf beendete.
 */
export const HELPER_SCRIPT = [
  'set -euo pipefail',
  'umask 077',
  'dir="${BACKUP_DIR:-/backup}"',
  'tmp="$dir/.${BACKUP_NAME}.tmp"',
  'gnupg=""',
  'trap \'rm -f "$tmp"; if [ -n "$gnupg" ]; then rm -rf "$gnupg"; fi\' EXIT',
  'if [ "${BACKUP_ENCRYPT:-0}" = 1 ]; then',
  `  key="\${BACKUP_KEY_FILE:-/data/${KEY_FILE}}"`,
  '  if [ ! -s "$key" ]; then echo "Der Sicherungsschlüssel fehlt." >&2; exit 1; fi',
  '  gnupg="$(mktemp -d)"',
  `  tar -czf - -C "/data/${STAGING}" . -C /etc haproxy -C /root .acme.sh | gpg --homedir "$gnupg" ${GPG_ENCRYPT_FLAGS} --passphrase-file "$key" -o "$tmp"`,
  'else',
  `  tar -czf "$tmp" -C "/data/${STAGING}" . -C /etc haproxy -C /root .acme.sh`,
  'fi',
  'mv "$tmp" "$dir/${BACKUP_NAME}"',
  // Älteste zuerst weg. Der Name trägt den Zeitpunkt, also sortiert `ls` richtig.
  'if [ "${BACKUP_PRUNE:-1}" = 1 ]; then',
  '  ls -1 "$dir" | { grep -E "^hapm-backup-[0-9]{8}-[0-9]{6}\\.tar\\.gz(\\.gpg)?$" || true; } | sort -r | tail -n "+$((BACKUP_KEEP + 1))" | while IFS= read -r old; do rm -f -- "$dir/$old"; done',
  'fi',
  `echo '${LIST_MARK}'`,
  'ls -1 "$dir" | { grep -E "^hapm-backup-[0-9]{8}-[0-9]{6}(-vor-ruecksicherung)?\\.tar\\.gz(\\.gpg)?$" || true; } | sort -r | while IFS= read -r f; do printf "%s %s\\n" "$(stat -c %s "$dir/$f")" "$f"; done',
].join('\n');

/** Die Liste am Ende der Ausgabe des Helfers: `<bytes> <name>` je Zeile. */
export function parseBackupList(output: string): BackupFile[] {
  const at = output.lastIndexOf(LIST_MARK);
  if (at === -1) return [];
  const files: BackupFile[] = [];
  for (const line of output.slice(at + LIST_MARK.length).split('\n')) {
    const match = /^(\d+) (\S+)$/.exec(line.trim());
    if (match && isBackupArchiveName(match[2])) files.push({ sizeBytes: Number(match[1]), name: match[2] });
  }
  return files;
}

type StepFn = (label: string, ok: boolean, detail?: string) => Promise<void>;

class StepLog {
  readonly steps: HaproxyStep[] = [];
  constructor(private readonly runId: string) {}

  add: StepFn = async (label, ok, detail) => {
    this.steps.push({ label, ok, ...(detail ? { detail: detail.slice(0, 1500) } : {}) });
    await updateDocument<BackupRun>(BACKUP_RUNS, this.runId, { steps: JSON.stringify(this.steps) }).catch(
      () => undefined
    );
  };
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
async function runHelper(
  target: BackupTarget,
  fileName: string,
  encrypt: boolean
): Promise<{ output: string; code: number }> {
  const own = ownContainer();
  if (!own) throw new Error(msgid('HAPM läuft nicht in einem Container. Die Sicherung braucht Docker.'));
  const self: any = await engine.inspectContainer(own);
  const folder = target.kind === 'folder';

  const helper = `hapm-backup-${Date.now()}`;
  await engine.createContainer(helper, {
    Image: self.Image,
    // bash wegen `pipefail`, siehe `HELPER_SCRIPT`.
    Entrypoint: ['bash', '-c'],
    Cmd: [HELPER_SCRIPT],
    Env: [
      `BACKUP_NAME=${fileName}`,
      `BACKUP_KEEP=${folder ? target.keep : 0}`,
      `BACKUP_DIR=${folder ? '/backup' : '/data'}`,
      `BACKUP_PRUNE=${folder && target.prune ? 1 : 0}`,
      // Nur der Schalter. Der Schlüssel selbst steht in einer Datei, siehe `KEY_FILE`.
      `BACKUP_ENCRYPT=${encrypt ? 1 : 0}`,
    ],
    User: 'root',
    HostConfig: folder
      ? {
          // Alle Volumes von HAPM, nur lesend. Geschrieben wird allein in den Ordner.
          VolumesFrom: [`${self.Id}:ro`],
          Binds: [`${target.hostPath}:/backup`],
          NetworkMode: 'none',
        }
      : {
          // Das Ziel ist der Daten-Ordner selbst, also schreibend.
          VolumesFrom: [self.Id],
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

/**
 * Datenbank, Schlüssel und Manifest in den Zwischenordner, dann schreibt der
 * Helfer das Archiv. Wirft mit dem Grund, wenn es nicht geklappt hat.
 *
 * `keepDumpAt`: die herausgeschriebene Datenbank dorthin kopieren, bevor der
 * Zwischenordner verschwindet. Das Zurückspielen spielt sie bei einem Fehler
 * wieder ein.
 *
 * `passphrase`: der Sicherungsschlüssel im Klartext. Mit ihm muss der Name auf
 * `.gpg` enden und ohne ihn nicht (`archiveNameFor` hält beides zusammen): ein
 * verschlüsseltes Archiv unter einem Namen, der es nicht sagt, erkennte beim
 * Aufräumen und in der Liste niemand wieder.
 */
export async function writeArchive(options: {
  target: BackupTarget;
  fileName: string;
  kind: BackupKind;
  onStep?: StepFn;
  keepDumpAt?: string;
  passphrase?: string | null;
}): Promise<WrittenArchive> {
  const { target, fileName } = options;
  const passphrase = options.passphrase || null;
  if ((passphrase !== null) !== isEncryptedName(fileName)) {
    throw new Error('writeArchive: Name und Sicherungsschlüssel passen nicht zusammen.');
  }
  const step: StepFn = options.onStep ?? (async () => undefined);
  const staging = dataPath(STAGING);
  const keyFile = dataPath(KEY_FILE);
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(path.join(staging, 'data'), { recursive: true, mode: 0o700 });

    const dumped = await dumpDatabase(staging);
    await step(msgid('Datenbank herausgeschrieben'), true, `${Math.max(1, Math.round(dumped / 1024))} KB`);

    fs.copyFileSync(dataPath('secrets.json'), path.join(staging, 'data', 'secrets.json'));
    const manifest = buildManifest({
      kind: options.kind,
      encryptionKey: secrets().encryptionKey,
      keyFromEnvironment: Boolean(process.env.ENCRYPTION_KEY),
      encrypted: passphrase !== null,
    });
    fs.writeFileSync(path.join(staging, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await step(msgid('Schlüssel dazugelegt'), true);

    if (passphrase !== null) {
      fs.rmSync(keyFile, { force: true });
      fs.writeFileSync(keyFile, `${passphrase}\n`, { mode: 0o600 });
    }
    const helper = await runHelper(target, fileName, passphrase !== null);
    const files = target.kind === 'folder' ? parseBackupList(helper.output) : [];
    const location =
      target.kind === 'folder' ? `${target.hostPath}/${fileName}` : dataPath(fileName);
    let sizeBytes: number | null = null;
    if (target.kind === 'folder') sizeBytes = files.find((file) => file.name === fileName)?.sizeBytes ?? null;
    else if (helper.code === 0) sizeBytes = fs.statSync(dataPath(fileName), { throwIfNoEntry: false })?.size ?? null;

    if (helper.code !== 0 || sizeBytes === null) {
      const head = helper.output.split(LIST_MARK)[0].trim().slice(-600);
      await step(msgid('Archiv geschrieben'), false, head || `Der Helfer endete mit Exit-Code ${helper.code}.`);
      throw new Error(
        target.kind === 'folder'
          ? `Das Archiv ließ sich nicht nach ${target.hostPath} schreiben.`
          : `Das Archiv ließ sich nicht nach ${location} schreiben.`
      );
    }
    await step(msgid('Archiv geschrieben'), true, passphrase !== null ? `${location}, verschlüsselt` : location);

    if (options.keepDumpAt) {
      fs.mkdirSync(path.dirname(options.keepDumpAt), { recursive: true, mode: 0o700 });
      fs.copyFileSync(path.join(staging, 'database.sql'), options.keepDumpAt);
      fs.chmodSync(options.keepDumpAt, 0o600);
    }
    return { location, fileName, sizeBytes, files };
  } finally {
    // Der herausgeschriebene Stand der Datenbank soll nicht im Volume liegen bleiben.
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(keyFile, { force: true });
  }
}

/**
 * Name und Sicherungsschlüssel für ein Archiv im Ordner, aus den Einstellungen.
 * Wirft, wenn ein Schlüssel gespeichert, aber nicht lesbar ist: dann wird nicht
 * ersatzweise unverschlüsselt geschrieben.
 */
export async function archiveNameFor(now: Date, suffix = ''): Promise<{ fileName: string; passphrase: string | null }> {
  const passphrase = readPassphrase(await getBackupSettings());
  return { fileName: backupFileName(now, suffix, passphrase !== null), passphrase };
}

async function execute(run: BackupRun, keep: number, actor: BackupActor): Promise<void> {
  const log = new StepLog(run.$id);
  const fileName = run.fileName!;
  let failure: string | null = null;

  try {
    // Im Lauf gelesen und nicht beim Start: ein Schlüssel, der sich nicht mehr
    // lesen lässt, steht so als Fehler in der Historie und geht als Mail
    // hinaus, auch nachts.
    const passphrase = run.encrypted ? readPassphrase(await getBackupSettings()) : null;
    if (run.encrypted && passphrase === null) {
      throw new Error(msgid('Der Sicherungsschlüssel wurde entfernt, als die Sicherung begann.'));
    }
    const written = await writeArchive({
      target: { kind: 'folder', hostPath: run.hostPath, keep, prune: true },
      fileName,
      kind: actor.userEmail === 'scheduler' ? 'scheduled' : 'manual',
      onStep: log.add,
      passphrase,
    });
    await log.add(
      msgid('Alte Sicherungen aufgeräumt'),
      true,
      `${written.files.filter((file) => !file.name.includes(BEFORE_RESTORE_SUFFIX)).length} von höchstens ${keep} liegen im Ordner.`
    );

    await updateDocument<BackupRun>(BACKUP_RUNS, run.$id, {
      status: 'success',
      completedAt: new Date().toISOString(),
      sizeBytes: written.sizeBytes,
      files: JSON.stringify(written.files),
    });
  } catch (err) {
    failure = message(err);
    if (!log.steps.some((step) => !step.ok)) await log.add(msgid('Abbruch'), false, failure);
    await updateDocument<BackupRun>(BACKUP_RUNS, run.$id, {
      status: 'error',
      completedAt: new Date().toISOString(),
      error: failure,
    }).catch(() => undefined);
  } finally {
    releaseBackupLock();
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

/** Gesetzt von `./restore.ts`, solange ein Zurückspielen läuft. Ohne Import, sonst hingen beide Module aneinander. */
const restoreFlag = globalThis as unknown as { __hapmRestoreRunning?: boolean };

export async function startBackup(actor: BackupActor): Promise<BackupRun> {
  const settings = await getBackupSettings();
  if (!settings.hostPath) throw new ApiError(msg('Es ist kein Ordner für die Sicherung eingestellt.'));
  if (!ownContainer()) throw new ApiError(msg('HAPM läuft nicht in einem Container. Die Sicherung braucht Docker.'));
  if (restoreFlag.__hapmRestoreRunning) throw new ApiError(msg('Es läuft gerade ein Zurückspielen.'), 409);
  if (!claimBackupLock()) throw new ApiError(msg('Es läuft schon eine Sicherung.'), 409);

  let run: BackupRun;
  try {
    run = await createDocument<BackupRun>(BACKUP_RUNS, {
      status: 'running',
      startedAt: new Date().toISOString(),
      completedAt: null,
      hostPath: settings.hostPath,
      // Ob verschlüsselt wird, steht mit dem Namen fest. Gelesen wird der Schlüssel erst im Lauf.
      fileName: backupFileName(new Date(), '', Boolean(settings.passphrase)),
      encrypted: Boolean(settings.passphrase),
      sizeBytes: null,
      files: null,
      steps: '[]',
      error: null,
      triggeredBy: actor.userEmail,
    });
  } catch (err) {
    releaseBackupLock();
    throw err;
  }

  void execute(run, settings.keep, actor);
  return run;
}

export async function listBackupRuns(limit = 20): Promise<BackupRun[]> {
  return listDocuments<BackupRun>(BACKUP_RUNS, [Query.orderDesc('startedAt'), Query.limit(limit)]);
}

export const BACKUP_INTERRUPTED = msgid('HAPM wurde während der Sicherung neu gestartet.');

/** Beim Start: ein offener Lauf ist mit dem vorigen Prozess gestorben. Gibt die Kennungen dieser Läufe zurück. */
export async function reconcileBackupRuns(): Promise<string[]> {
  const open = await listDocuments<BackupRun>(BACKUP_RUNS, [Query.equal('status', 'running'), Query.limit(20)]);
  for (const run of open) {
    await updateDocument<BackupRun>(BACKUP_RUNS, run.$id, {
      status: 'error',
      completedAt: new Date().toISOString(),
      error: BACKUP_INTERRUPTED,
    });
  }
  fs.rmSync(dataPath(STAGING), { recursive: true, force: true });
  fs.rmSync(dataPath(KEY_FILE), { force: true });
  return open.map((run) => run.$id);
}

/** Wie viele dieser Läufe nach dem Abgleich des Zurückspielens noch als abgebrochen dastehen. */
export async function stillInterruptedBackups(ids: string[]): Promise<number> {
  let count = 0;
  for (const id of ids) {
    const run = await getDocument<BackupRun>(BACKUP_RUNS, id).catch(() => null);
    if (run?.status === 'error' && run.error === BACKUP_INTERRUPTED) count++;
  }
  return count;
}

export async function pruneBackupRuns(olderThanIso: string): Promise<number> {
  return deleteWhere(BACKUP_RUNS, [Query.lessThan('startedAt', olderThanIso)]);
}
