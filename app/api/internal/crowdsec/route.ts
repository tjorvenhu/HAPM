import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError } from '@/lib/api';
import { crowdsecOverview } from '@/lib/crowdsec/actions';

/** Zustand von CrowdSec und Bouncer, welche Ziele geprüft werden, Zahlen der letzten 24 Stunden. */
export async function GET(request: Request) {
  try {
    await requireServiceToken(request);
    return ok(await crowdsecOverview());
  } catch (err) {
    return handleError(err);
  }
}
