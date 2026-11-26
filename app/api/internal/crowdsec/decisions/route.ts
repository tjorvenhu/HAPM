import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError, jsonBody } from '@/lib/api';
import { getClientIP, serviceActor } from '@/lib/audit';
import { listDecisions, addDecision, removeDecision } from '@/lib/crowdsec/actions';

/** Die aktiven Sperren (ohne die Gemeinschaftsliste). */
export async function GET(request: Request) {
  try {
    await requireServiceToken(request);
    return ok({ decisions: await listDecisions() });
  } catch (err) {
    return handleError(err);
  }
}

/** Eine Adresse oder ein Netz sperren: `{ value, duration, reason }`. */
export async function POST(request: Request) {
  try {
    const service = await requireServiceToken(request);
    const body = await jsonBody(request);
    return ok(await addDecision(body, { ...serviceActor(service), ip: getClientIP(request) }));
  } catch (err) {
    return handleError(err);
  }
}

/** Eine Sperre aufheben: `{ id }`, oder alle einer Adresse: `{ value }`. */
export async function DELETE(request: Request) {
  try {
    const service = await requireServiceToken(request);
    const body = await jsonBody(request);
    return ok(await removeDecision(body, { ...serviceActor(service), ip: getClientIP(request) }));
  } catch (err) {
    return handleError(err);
  }
}
