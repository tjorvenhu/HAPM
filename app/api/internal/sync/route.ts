import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError } from '@/lib/api';
import { getClientIP, serviceActor } from '@/lib/audit';
import { startSyncRun, syncOverview } from '@/lib/sync/actions';

/**
 * Der Abgleich zwischen Knoten, wie auf der Seite „Abgleich": Rolle,
 * Folgeknoten mit ihrem Zustand, die letzten Läufe. Dieselben Funktionen wie
 * `/api/sync` (`lib/sync/actions.ts`).
 *
 * Rolle, Kopplungsschlüssel und Gegenstellen gibt es hier bewusst nicht: der
 * Schlüssel ist ein Geheimnis, und wer die Rolle umstellt, entscheidet, welcher
 * Knoten den anderen überschreibt (docs/mcp.md, „Was es bewusst nicht gibt").
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    await requireServiceToken(request);
    return ok(await syncOverview());
  } catch (err) {
    return handleError(err);
  }
}

/** „Jetzt abgleichen" (nur Hauptknoten). Antwortet mit `runId`, der Stand steht unter `./runs/{runId}`. */
export async function POST(request: Request) {
  try {
    const service = await requireServiceToken(request);
    return ok(await startSyncRun({ ...serviceActor(service), ip: getClientIP(request) }));
  } catch (err) {
    return handleError(err);
  }
}
