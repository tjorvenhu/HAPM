import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody } from '@/lib/api';
import { getClientIP } from '@/lib/audit';
import { crowdsecRules, changeRules } from '@/lib/crowdsec/actions';

/** Die Regelsammlungen und der Modus der OWASP-Regeln. */
export async function GET() {
  try {
    await requireSession();
    return ok(await crowdsecRules());
  } catch (err) {
    return handleError(err);
  }
}

/** `{ crs: off|detect|block }`, `{ name, installed }` für eine Sammlung oder `{ upgrade: true }` für den Hub. */
export async function PATCH(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody(request);
    const actor = { userId: session.userId, userEmail: session.email, ip: getClientIP(request) };
    return ok(await changeRules(body, actor));
  } catch (err) {
    return handleError(err);
  }
}
