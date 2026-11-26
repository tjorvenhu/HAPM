import { requireSession } from '@/lib/session';
import { ok, handleError } from '@/lib/api';
import { crowdsecLog } from '@/lib/crowdsec/actions';

/** Die Ausgabe eines der beiden Container: `?container=crowdsec|bouncer&tail=300`, neueste Zeile zuerst. */
export async function GET(request: Request) {
  try {
    await requireSession();
    const params = new URL(request.url).searchParams;
    return ok(await crowdsecLog(params.get('container'), params.get('tail')));
  } catch (err) {
    return handleError(err);
  }
}
