import { requireCsrf, requireSession } from '@/lib/session';
import { getUser, deleteUser } from '@/lib/auth/users';
import { logAudit, getClientIP } from '@/lib/audit';
import { ok, handleError, ApiError } from '@/lib/api';

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const { id } = await params;

    const user = await getUser(id);
    if (!user) throw new ApiError('Dieses Konto gibt es nicht.', 404);

    // Nimmt Sitzungen, Passkeys und den zweiten Faktor des Kontos mit.
    await deleteUser(id, session.userId);

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'user_deleted',
      resource: 'user',
      resourceId: id,
      details: `${user.name} <${user.email}>`,
      ip: getClientIP(request),
    });

    return ok();
  } catch (err) {
    return handleError(err);
  }
}
