import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody } from '@/lib/api';
import { getClientIP } from '@/lib/audit';
import { addSyncPeer } from '@/lib/sync/actions';

export const dynamic = 'force-dynamic';

/**
 * Einen Folgeknoten eintragen (nur Hauptknoten): `{ "url", "key", "name"? }`.
 * Gespeichert wird erst, wenn er mit diesem Schlüssel geantwortet hat.
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody(request);
    return ok(await addSyncPeer(body, { userId: session.userId, userEmail: session.email, ip: getClientIP(request) }));
  } catch (err) {
    return handleError(err);
  }
}
