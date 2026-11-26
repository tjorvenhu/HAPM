import { requireSession } from '@/lib/session';
import { ok, handleError } from '@/lib/api';
import { getClientIP } from '@/lib/audit';
import { crowdsecOverview } from '@/lib/crowdsec/actions';

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
