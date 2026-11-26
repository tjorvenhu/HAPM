import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError } from '@/lib/api';
import { getClientIP } from '@/lib/audit';
import { removeSyncPeer } from '@/lib/sync/actions';

type Params = { params: Promise<{ id: string }> };

export const dynamic = 'force-dynamic';

/** Einen Folgeknoten austragen. Er behält seinen letzten Stand. */
export async function DELETE(request: Request, { params }: Params) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const { id } = await params;
    return ok(await removeSyncPeer(id, { userId: session.userId, userEmail: session.email, ip: getClientIP(request) }));
  } catch (err) {
    return handleError(err);
  }
}
