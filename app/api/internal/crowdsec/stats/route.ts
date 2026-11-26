import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError } from '@/lib/api';
import { crowdsecStatistics } from '@/lib/crowdsec/actions';

/** Die Statistik aus den Ereignissen eines Zeitraums: `?window=24h|7d|30d`. */
export async function GET(request: Request) {
  try {
    await requireServiceToken(request);
    const params = new URL(request.url).searchParams;
    return ok(await crowdsecStatistics(params.get('window')));
  } catch (err) {
    return handleError(err);
  }
}
