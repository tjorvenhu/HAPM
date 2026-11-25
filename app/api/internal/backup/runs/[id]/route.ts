import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError } from '@/lib/api';
import { getT } from '@/lib/i18n/server';
import { getBackupRun } from '@/lib/backup/actions';

type Params = { params: Promise<{ id: string }> };

/** Der Stand eines Sicherungslaufs. Ohne Audit: der Aufrufer pollt. */
export async function GET(request: Request, { params }: Params) {
  try {
    await requireServiceToken(request);
    const { id } = await params;
    const { t } = await getT();
    return ok(await getBackupRun(id, t));
  } catch (err) {
    return handleError(err);
  }
}
