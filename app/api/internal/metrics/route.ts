import { requireServiceToken } from '@/lib/service-auth';
import { handleError } from '@/lib/api';
import { getT } from '@/lib/i18n/server';
import { readMetrics } from '@/lib/system/monitoring';

/**
 * Der Zustand der Installation im Textformat von Prometheus
 * (`lib/system/metrics.ts`). Das Token geht als `Authorization: Bearer …`, in
 * Prometheus also `authorization: { credentials: … }` am Job.
 *
 * Die Antwort ist Text und nicht die übliche Hülle `{ success, data }`:
 * Prometheus liest nur dieses Format. Fehler (401, 403, 429) kommen wie
 * überall als JSON, Prometheus zeigt dann den Statuscode.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    await requireServiceToken(request);
    const body = await readMetrics(await getT());
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return handleError(err);
  }
}
