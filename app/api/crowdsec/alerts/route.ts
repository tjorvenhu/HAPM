import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError } from '@/lib/api';
import { getClientIP } from '@/lib/audit';
import { clearCrowdsec, listAlerts } from '@/lib/crowdsec/actions';

/** Die Ereignisse: `?window=24h|7d|30d`, `?service=<id>` nur die eines Ziels. */
export async function GET(request: Request) {
  try {
    await requireSession();
    const params = new URL(request.url).searchParams;
    return ok(await listAlerts({ window: params.get('window'), service: params.get('service') }));
  } catch (err) {
    return handleError(err);
  }
}

/** CrowdSec leeren: alle Ereignisse und die Sperren, die CrowdSec daraus verhängt hat. */
export async function DELETE(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const actor = { userId: session.userId, userEmail: session.email, ip: getClientIP(request) };
    return ok(await clearCrowdsec(actor));
  } catch (err) {
    return handleError(err);
  }
}
