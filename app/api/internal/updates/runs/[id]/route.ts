import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError } from '@/lib/api';
import { getT } from '@/lib/i18n/server';
import { getUpdateRun } from '@/lib/updates/actions';

type Params = { params: Promise<{ id: string }> };

/**
 * Der Stand eines Update-Laufs. Ohne Audit, wie `../../haproxy/runs/[id]`:
 * der Aufrufer pollt.
 */
export async function GET(request: Request, { params }: Params) {
  try {
    await requireServiceToken(request);
    const { id } = await params;
    const { t } = await getT();
    return ok(await getUpdateRun(id, t));
  } catch (err) {
    return handleError(err);
  }
}
