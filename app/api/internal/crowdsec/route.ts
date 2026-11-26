import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError, jsonBody } from '@/lib/api';
import { getClientIP, serviceActor } from '@/lib/audit';
import { crowdsecOverview, setCrowdsecEnabled } from '@/lib/crowdsec/actions';

/** Zustand von CrowdSec und Bouncer, welche Ziele geprüft werden, Zahlen der letzten 24 Stunden. */
export async function GET(request: Request) {
  try {
    await requireServiceToken(request);
    return ok(await crowdsecOverview());
  } catch (err) {
    return handleError(err);
  }
}

/** `{ enabled: false }` schaltet CrowdSec ganz ab (aus jedem Ziel, Container angehalten), `true` wieder ein. */
export async function PATCH(request: Request) {
  try {
    const service = await requireServiceToken(request);
    const body = await jsonBody(request);
    return ok(await setCrowdsecEnabled(body, { ...serviceActor(service), ip: getClientIP(request) }));
  } catch (err) {
    return handleError(err);
  }
}
