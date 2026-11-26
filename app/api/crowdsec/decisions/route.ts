import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody } from '@/lib/api';
import { getClientIP } from '@/lib/audit';
import { listDecisions, addDecision, removeDecision } from '@/lib/crowdsec/actions';

/** Die aktiven Sperren (ohne die Gemeinschaftsliste). */
export async function GET() {
  try {
    await requireSession();
    return ok({ decisions: await listDecisions() });
  } catch (err) {
    return handleError(err);
  }
}

/** Eine Adresse oder ein Netz sperren: `{ value, duration, reason }`. */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody(request);
    const actor = { userId: session.userId, userEmail: session.email, ip: getClientIP(request) };
    return ok(await addDecision(body, actor));
  } catch (err) {
    return handleError(err);
  }
}

/** Eine Sperre aufheben: `{ id }`, oder alle einer Adresse: `{ value }`. */
export async function DELETE(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody(request);
    const actor = { userId: session.userId, userEmail: session.email, ip: getClientIP(request) };
    return ok(await removeDecision(body, actor));
  } catch (err) {
    return handleError(err);
  }
}
