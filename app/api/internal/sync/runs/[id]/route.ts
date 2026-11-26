import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError } from '@/lib/api';
import { getT } from '@/lib/i18n/server';
import { getSyncRun } from '@/lib/sync/actions';

type Params = { params: Promise<{ id: string }> };

/** Der Stand eines Laufs des Abgleichs. Ohne Audit: der Aufrufer pollt. */
export async function GET(request: Request, { params }: Params) {
  try {
    await requireServiceToken(request);
    const { id } = await params;
    const { t } = await getT();
    return ok(await getSyncRun(id, t));
  } catch (err) {
    return handleError(err);
  }
}
