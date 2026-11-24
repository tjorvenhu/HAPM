import { requireSession } from '@/lib/session';
import { getUser } from '@/lib/auth/users';
import { ok, handleError, ApiError } from '@/lib/api';

export async function GET() {
  try {
    const session = await requireSession();
    const user = await getUser(session.userId);
    if (!user) throw new ApiError('Dieses Konto gibt es nicht mehr.', 404);
    return ok(user);
  } catch (err) {
    return handleError(err);
  }
}
