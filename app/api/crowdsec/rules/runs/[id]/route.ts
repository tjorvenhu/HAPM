import { requireSession } from '@/lib/session';
import { ok, handleError, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { getT } from '@/lib/i18n/server';
import { ruleRunView } from '@/lib/crowdsec/rule-jobs';

type Params = { params: Promise<{ id: string }> };

export const dynamic = 'force-dynamic';

/**
 * Ein Lauf, der Regeln von CrowdSec ändert, für das Fenster der Läufe
 * (`components/runs/RunOverlay.tsx`). Die Läufe stehen im Speicher
 * (`lib/crowdsec/rule-jobs.ts`): nach einem Neustart von HAPM gibt es sie nicht mehr.
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    await requireSession();
    const { id } = await params;
    const { t } = await getT();
    const run = ruleRunView(id, t);
    if (!run) throw new ApiError(msg('Diesen Lauf gibt es nicht.'), 404);
    return ok(run);
  } catch (err) {
    return handleError(err);
  }
}
