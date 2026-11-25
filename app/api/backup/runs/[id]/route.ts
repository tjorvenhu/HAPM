import { requireSession } from '@/lib/session';
import { getDocument } from '@/lib/db';
import { ok, handleError, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { BACKUP_RUNS } from '@/lib/backup/settings';
import type { BackupRun } from '@/lib/backup/run';
import type { HaproxyStep } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

export const dynamic = 'force-dynamic';

/** Ein Sicherungslauf für das Fenster der Läufe (`components/runs/RunOverlay.tsx`). */
export async function GET(_request: Request, { params }: Params) {
  try {
    await requireSession();
    const { id } = await params;
    const run = await getDocument<BackupRun>(BACKUP_RUNS, id).catch(() => null);
    if (!run) throw new ApiError(msg('Diesen Lauf gibt es nicht.'), 404);
    return ok({
      $id: run.$id,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      hostPath: run.hostPath,
      fileName: run.fileName,
      error: run.error,
      steps: JSON.parse(run.steps ?? '[]') as HaproxyStep[],
    });
  } catch (err) {
    return handleError(err);
  }
}
