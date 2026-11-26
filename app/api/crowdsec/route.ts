import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody } from '@/lib/api';
import { getClientIP } from '@/lib/audit';
import { crowdsecOverview, setCrowdsecEnabled } from '@/lib/crowdsec/actions';

/**
 * Zustand von CrowdSec und Bouncer, welche Ziele geprüft werden, Zahlen der
 * letzten 24 Stunden. Dazu die eigene Adresse: die Seite bietet an, sie
 * freizugeben, und warnt, wenn sie gesperrt ist.
 */
export async function GET(request: Request) {
  try {
    await requireSession();
    return ok({ ...(await crowdsecOverview()), client: getClientIP(request) });
  } catch (err) {
    return handleError(err);
  }
}

/** `{ enabled: false }` schaltet CrowdSec ganz ab (aus jedem Ziel, Container angehalten), `true` wieder ein. */
export async function PATCH(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody(request);
    const actor = { userId: session.userId, userEmail: session.email, ip: getClientIP(request) };
    return ok(await setCrowdsecEnabled(body, actor));
  } catch (err) {
    return handleError(err);
  }
}
