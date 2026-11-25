import { requireSession } from '@/lib/session';
import { getUser } from '@/lib/auth/users';
import { get2FAConfig, recoveryCodesLeft } from '@/lib/two-factor';
import { ok, handleError, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';

export async function GET() {
  try {
    const session = await requireSession();
    const [user, twoFactor] = await Promise.all([getUser(session.userId), get2FAConfig(session.userId)]);
    if (!user) throw new ApiError(msg('Dieses Konto gibt es nicht mehr.'), 404);
    return ok({ ...user, recoveryCodesLeft: recoveryCodesLeft(twoFactor) });
  } catch (err) {
    return handleError(err);
  }
}
