import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody } from '@/lib/api';
import { getClientIP } from '@/lib/audit';
import { backupOverview, changeBackupSettings, startBackupRun } from '@/lib/backup/actions';

export const dynamic = 'force-dynamic';

export type { BackupOverview, BackupRunForClient } from '@/lib/backup/actions';

export async function GET() {
  try {
    await requireSession();
    return ok(await backupOverview());
  } catch (err) {
    return handleError(err);
  }
}

export async function PATCH(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody(request);
    return ok(
      await changeBackupSettings(body, { userId: session.userId, userEmail: session.email, ip: getClientIP(request) })
    );
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    return ok(await startBackupRun({ userId: session.userId, userEmail: session.email, ip: getClientIP(request) }));
  } catch (err) {
    return handleError(err);
  }
}
