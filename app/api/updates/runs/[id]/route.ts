import { requireSession } from '@/lib/session';
import { getDocument } from '@/lib/db';
import { COLLECTIONS } from '@/lib/types';
import { ok, handleError, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { parseSteps } from '@/lib/haproxy/runner';
import type { UpdateRun } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

export const dynamic = 'force-dynamic';

/** Ein Update-Lauf für das Fenster der Läufe (`components/runs/RunOverlay.tsx`). */
export async function GET(_request: Request, { params }: Params) {
  try {
    await requireSession();
    const { id } = await params;
    const run = await getDocument<UpdateRun>(COLLECTIONS.UPDATE_RUNS, id).catch(() => null);
    if (!run) throw new ApiError(msg('Diesen Lauf gibt es nicht.'), 404);
    return ok({ ...run, steps: parseSteps(run.steps) });
  } catch (err) {
    return handleError(err);
  }
}
