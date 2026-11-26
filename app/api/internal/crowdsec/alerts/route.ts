import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError } from '@/lib/api';
import { getClientIP, serviceActor } from '@/lib/audit';
import { clearCrowdsec, listAlerts } from '@/lib/crowdsec/actions';

/** Die Ereignisse: `?window=24h|7d|30d`, `?service=<id>` nur die eines Ziels. */
export async function GET(request: Request) {
  try {
    await requireServiceToken(request);
    const params = new URL(request.url).searchParams;
    return ok(await listAlerts({ window: params.get('window'), service: params.get('service') }));
  } catch (err) {
    return handleError(err);
  }
}

/** CrowdSec leeren: alle Ereignisse und die Sperren, die CrowdSec daraus verhängt hat. */
export async function DELETE(request: Request) {
  try {
    const service = await requireServiceToken(request);
    return ok(await clearCrowdsec({ ...serviceActor(service), ip: getClientIP(request) }));
  } catch (err) {
    return handleError(err);
  }
}
