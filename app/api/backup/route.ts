import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody } from '@/lib/api';
import { logAudit, getClientIP } from '@/lib/audit';
import { ownContainer } from '@/lib/docker';
import { getBackupSettings, updateBackupSettings, type BackupSettingsInput } from '@/lib/backup/settings';
import { backupRunning, listBackupRuns, startBackup, type BackupFile, type BackupRun } from '@/lib/backup/run';

export const dynamic = 'force-dynamic';

function forClient(run: BackupRun) {
  return {
    ...run,
    steps: JSON.parse(run.steps ?? '[]') as unknown[],
    files: JSON.parse(run.files ?? '[]') as BackupFile[],
  };
}

export type BackupRunForClient = ReturnType<typeof forClient>;

async function overview() {
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

export type BackupOverview = Awaited<ReturnType<typeof overview>>;

export async function GET() {
  try {
    await requireSession();
    return ok(await overview());
  } catch (err) {
    return handleError(err);
  }
}

export async function PATCH(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody<BackupSettingsInput>(request);
    const settings = await updateBackupSettings({
      enabled: body.enabled,
      hostPath: body.hostPath,
      time: body.time,
      keep: body.keep,
    });
    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'backup_settings_updated',
      resource: 'backup',
      details: `${settings.enabled ? `täglich ${settings.time}` : 'nicht täglich'}, Ordner ${settings.hostPath ?? 'keiner'}, ${settings.keep} aufbewahren`,
      ip: getClientIP(request),
    });
    return ok(await overview());
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const ip = getClientIP(request);
    const run = await startBackup({ userId: session.userId, userEmail: session.email, ip });
    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'backup_started',
      resource: 'backup',
      details: `${run.hostPath}/${run.fileName}`,
      ip,
    });
    return ok({ runId: run.$id });
  } catch (err) {
    return handleError(err);
  }
}
