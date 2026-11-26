import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody } from '@/lib/api';
import { getClientIP } from '@/lib/audit';
import { changeSyncRole, startSyncRun, syncOverview } from '@/lib/sync/actions';

export const dynamic = 'force-dynamic';

export type { SyncOverview, SyncPeerView, SyncRunView } from '@/lib/sync/actions';

/** Der Abgleich, wie ihn die Seite „Abgleich" zeigt: Rolle, Gegenstellen, Läufe. */
export async function GET() {
  try {
    await requireSession();
    return ok(await syncOverview());
  } catch (err) {
    return handleError(err);
  }
}

/** Die Rolle dieses Knotens umstellen: `{ "role": "single" | "primary" | "replica" }`. */
export async function PATCH(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody(request);
    return ok(await changeSyncRole(body, { userId: session.userId, userEmail: session.email, ip: getClientIP(request) }));
  } catch (err) {
    return handleError(err);
  }
}

/** „Jetzt abgleichen". Antwortet mit `runId`, der Stand steht unter `./runs/{runId}`. */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    return ok(await startSyncRun({ userId: session.userId, userEmail: session.email, ip: getClientIP(request) }));
  } catch (err) {
    return handleError(err);
  }
}
