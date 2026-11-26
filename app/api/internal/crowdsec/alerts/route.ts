import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError } from '@/lib/api';
import { listAlerts } from '@/lib/crowdsec/actions';

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
