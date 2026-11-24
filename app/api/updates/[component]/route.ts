import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { getClientIP } from '@/lib/audit';
import { startUpdate } from '@/lib/updates/apply';
import type { UpdateComponent } from '@/lib/types';

const COMPONENTS: UpdateComponent[] = ['haproxy', 'hapm', 'acme'];

/**
 * Ein Update beginnen. Die Antwort trägt nur den Lauf: er läuft abgekoppelt
 * weiter, und das Protokoll schreibt `startUpdate` selbst.
 */
export async function POST(request: Request, { params }: { params: Promise<{ component: string }> }) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const { component } = await params;
    if (!COMPONENTS.includes(component as UpdateComponent)) {
      throw new ApiError(msg('Diesen Bestandteil gibt es nicht.'), 404);
    }

    const run = await startUpdate(component as UpdateComponent, {
      userId: session.userId,
      userEmail: session.email,
      ip: getClientIP(request),
    });
    return ok({ runId: run.$id });
  } catch (err) {
    return handleError(err);
  }
}
