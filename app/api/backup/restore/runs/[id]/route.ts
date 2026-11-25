import { requireSession } from '@/lib/session';
import { ok, handleError, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { restoreRunView } from '@/lib/backup/restore';

type Params = { params: Promise<{ id: string }> };

export const dynamic = 'force-dynamic';

/**
 * Ein Zurückspielen für das Fenster der Läufe (`components/runs/RunOverlay.tsx`).
 * Nach dem Neustart steht der Lauf in der zurückgespielten Datenbank, unter
 * derselben Kennung.
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    await requireSession();
    const { id } = await params;
    const run = await restoreRunView(id);
    if (!run) throw new ApiError(msg('Diesen Lauf gibt es nicht.'), 404);
    return ok(run);
  } catch (err) {
    return handleError(err);
  }
}
