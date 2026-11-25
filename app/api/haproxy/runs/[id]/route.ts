import { requireSession } from '@/lib/session';
import { getDocument } from '@/lib/db';
import { COLLECTIONS } from '@/lib/types';
import { ok, handleError, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { getT } from '@/lib/i18n/server';
import { parseSteps, stepsAsLog } from '@/lib/haproxy/runner';
import type { HaproxyRun } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

/**
 * Der Poll-Endpunkt des Fensters der Läufe, in der Form, die
 * `components/runs/sources.ts` liest.
 *
 * `output` ist ein Text: das Fenster zeigt ihn als Protokoll unter den Phasen.
 * Die Übersetzung steht in `stepsAsLog` und nicht hier, damit die Logs-Seite
 * dieselben Wörter zeigt. `serverName` trägt die Dienst-ID: das Feld ist der
 * Zusatz in der Überschrift des Fensters, und bei einer Maschine ist deren Name
 * dort keine Auskunft.
 */
export async function GET(request: Request, { params }: Params) {
  try {
    await requireSession();
    const { id } = await params;

    let run: HaproxyRun;
    try {
      run = await getDocument<HaproxyRun>(COLLECTIONS.HAPROXY_RUNS, id);
    } catch {
      throw new ApiError(msg('Reverse-Proxy-Vorgang nicht gefunden.'), 404);
    }

    const steps = parseSteps(run.steps);
    const { t } = await getT();

    return ok({
      $id: run.$id,
      serverId: run.serverId,
      serverName: run.serviceId,
      action: run.action,
      status: run.status,
      phase: run.phase,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      duration: run.duration,
      error: run.error === null ? null : t(run.error),
      output: stepsAsLog(steps, t),
      steps,
    });
  } catch (err) {
    return handleError(err);
  }
}
