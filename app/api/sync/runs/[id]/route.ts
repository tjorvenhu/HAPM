import { requireSession } from '@/lib/session';
import { ok, handleError } from '@/lib/api';
import { getT } from '@/lib/i18n/server';
import { getSyncRun } from '@/lib/sync/actions';

type Params = { params: Promise<{ id: string }> };

export const dynamic = 'force-dynamic';

/** Ein Lauf des Abgleichs für das Fenster der Läufe (`components/runs/RunOverlay.tsx`). */
export async function GET(_request: Request, { params }: Params) {
  try {
    await requireSession();
    const { id } = await params;
    const { t } = await getT();
    return ok(await getSyncRun(id, t));
  } catch (err) {
    return handleError(err);
  }
}
