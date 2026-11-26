import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody } from '@/lib/api';
import { getClientIP } from '@/lib/audit';
import { sendForwardTest } from '@/lib/audit-log/actions';

/**
 * Eine Testnachricht an das gespeicherte Ziel (`destination`: `syslog` oder
 * `http`). Begrenzung und Protokoll: `sendForwardTest`.
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody(request);
    return ok(
      await sendForwardTest(body.destination, { userId: session.userId, userEmail: session.email, ip: getClientIP(request) })
    );
  } catch (err) {
    return handleError(err);
  }
}
