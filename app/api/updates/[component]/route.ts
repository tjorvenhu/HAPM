import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError } from '@/lib/api';
import { getClientIP } from '@/lib/audit';
import { startComponentUpdate } from '@/lib/updates/actions';

/**
 * Ein Update beginnen. Die Antwort trägt nur den Lauf: er läuft abgekoppelt
 * weiter, und das Protokoll schreibt `startUpdate` selbst.
 */
export async function POST(request: Request, { params }: { params: Promise<{ component: string }> }) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const { component } = await params;
    return ok(
      await startComponentUpdate(component, {
        userId: session.userId,
        userEmail: session.email,
        ip: getClientIP(request),
      })
    );
  } catch (err) {
    return handleError(err);
  }
}
