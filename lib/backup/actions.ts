/**
 * Was die Seite „Sicherung", die interne API (`/api/internal/backup`) und der
 * MCP-Server gemeinsam tun: Stand lesen, Einstellungen ändern, eine Sicherung
 * starten, einen Lauf lesen. Jede schreibende Funktion schreibt ihr Protokoll
 * selbst, damit es keinen Weg ohne gibt.
 *
 * Das Zurückspielen steht bewusst nicht hier: es verlangt das Passwort eines
 * Menschen und ersetzt die Datenbank samt Konten und API-Keys (docs/mcp.md,
 * „Was es bewusst nicht gibt").
 */

import { getDocument } from '../db';
import { ApiError } from '../api';
import { msg } from '../i18n';
import { logAudit } from '../audit';
import { ownContainer } from '../docker';
import { parseSteps, stepsAsLog } from '../haproxy/runner';
import { BACKUP_RUNS, getBackupSettings, updateBackupSettings } from './settings';
import { backupRunning, listBackupRuns, startBackup, type BackupActor, type BackupFile, type BackupRun } from './run';

function forClient(run: BackupRun) {
  return {
    ...run,
    steps: JSON.parse(run.steps ?? '[]') as unknown[],
    files: JSON.parse(run.files ?? '[]') as BackupFile[],
  };
}

export type BackupRunForClient = ReturnType<typeof forClient>;

export async function backupOverview() {
  const [settings, runs] = await Promise.all([getBackupSettings(), listBackupRuns(15)]);
  const latestWithFiles = runs.find((run) => run.files);
  return {
    settings: {
      enabled: settings.enabled,
      hostPath: settings.hostPath,
      time: settings.time,
      keep: settings.keep,
    },
    // Ohne Container gibt es keinen Helfer, der in den Ordner schreiben könnte.
    available: ownContainer() !== null,
    running: backupRunning() || runs.some((run) => run.status === 'running'),
    runs: runs.map(forClient),
    // Der Stand des Ordners nach dem letzten Lauf, nicht live gelesen.
    files: latestWithFiles ? (JSON.parse(latestWithFiles.files ?? '[]') as BackupFile[]) : null,
    filesAsOf: latestWithFiles?.completedAt ?? null,
  };
}

export type BackupOverview = Awaited<ReturnType<typeof backupOverview>>;

/** Die Einstellungen ändern. Was nicht im Rumpf steht, bleibt (`updateBackupSettings`). */
export async function changeBackupSettings(body: Record<string, unknown>, actor: BackupActor): Promise<BackupOverview> {
  const settings = await updateBackupSettings({
    enabled: body.enabled as boolean | undefined,
    hostPath: body.hostPath as string | null | undefined,
    time: body.time as string | undefined,
    keep: body.keep as number | undefined,
  });
  await logAudit({
    ...actor,
    action: 'backup_settings_updated',
    resource: 'backup',
    details: `${settings.enabled ? `täglich ${settings.time}` : 'nicht täglich'}, Ordner ${settings.hostPath ?? 'keiner'}, ${settings.keep} aufbewahren`,
  });
  return backupOverview();
}

/** Eine Sicherung jetzt. Läuft abgekoppelt, die Antwort trägt den Lauf. */
export async function startBackupRun(actor: BackupActor): Promise<{ runId: string }> {
  const run = await startBackup(actor);
  await logAudit({
    ...actor,
    action: 'backup_started',
    resource: 'backup',
    details: `${run.hostPath}/${run.fileName}`,
  });
  return { runId: run.$id };
}

/** Ein Lauf der Sicherung, in der Form von `getRun`. */
export async function getBackupRun(id: string, t: (text: string) => string) {
  let run: BackupRun;
  try {
    run = await getDocument<BackupRun>(BACKUP_RUNS, id);
  } catch {
    throw new ApiError(msg('Sicherungslauf nicht gefunden.'), 404);
  }
  const steps = parseSteps(run.steps);
  return {
    id: run.$id,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    hostPath: run.hostPath,
    fileName: run.fileName,
    sizeBytes: run.sizeBytes,
    triggeredBy: run.triggeredBy,
    error: run.error === null ? null : t(run.error),
    steps,
    log: stepsAsLog(steps, t),
  };
}
