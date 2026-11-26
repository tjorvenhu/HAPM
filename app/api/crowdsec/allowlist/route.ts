import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody } from '@/lib/api';
import { getClientIP } from '@/lib/audit';
import { listAllowlist, addAllowlist, removeAllowlist } from '@/lib/crowdsec/actions';

/** Die Freigabeliste von HAPM. Freigegebene Adressen sperrt CrowdSec nicht, die WAF prüft sie nicht. */
export async function GET() {
  try {
    await requireSession();
    return ok({ entries: await listAllowlist() });
  } catch (err) {
    return handleError(err);
  }
}

/** Freigeben: `{ value, description, duration }` (`duration` leer: unbefristet). Hebt bestehende Sperren auf. */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody(request);
    const actor = { userId: session.userId, userEmail: session.email, ip: getClientIP(request) };
    return ok(await addAllowlist(body, actor));
  } catch (err) {
    return handleError(err);
  }
}

/** Eine Freigabe entfernen: `{ value }`. */
export async function DELETE(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody(request);
    const actor = { userId: session.userId, userEmail: session.email, ip: getClientIP(request) };
    return ok(await removeAllowlist(body, actor));
  } catch (err) {
    return handleError(err);
  }
}
