import { requireSession } from '@/lib/session';
import { ok, handleError } from '@/lib/api';
import { demandSeconds } from '@/lib/haproxy/stats-sampler';
import { secondStats } from '@/lib/haproxy/stats-seconds';

/**
 * Die Sekundenwerte der Live-Kacheln.
 *
 * Jeder Aufruf hält den Sampler am Leben (`lib/haproxy/stats-sampler.ts`): er
 * liest HAProxy jede Sekunde, solange hier gefragt wird, und hört eine halbe
 * Minute nach dem letzten Aufruf auf. Die Antwort kommt aus dem Speicher,
 * gefragt wird HAProxy hier nie direkt. Der erste Aufruf nach einer Pause
 * liefert deshalb noch nichts, die Kacheln zeigen bis dahin die Minutenwerte
 * aus `/api/haproxy/stats/live`.
 */
export async function GET(request: Request) {
  try {
    await requireSession();

    const scope = new URL(request.url).searchParams.get('scope')?.trim() || undefined;
    const now = Date.now();
    return ok(secondStats(demandSeconds(now), now, scope));
  } catch (err) {
    return handleError(err);
  }
}
