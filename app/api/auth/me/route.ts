import { getSession } from '@/lib/session';
import { ok, fail, handleError } from '@/lib/api';

/**
 * Die Sitzung, in der Form, die `ToolShell` (`ui/tool/ToolShell.tsx`) liest: ohne
 * Sitzung 401, mit `twoFactorPending` zurück zur Anmeldung.
 */
export async function GET() {
  try {
    const session = await getSession();
    if (!session.userId) return fail('Nicht authentifiziert', 401);

    return ok({
      userId: session.userId,
      email: session.email,
      name: session.name,
      twoFactorPending: !session.twoFactorVerified,
      twoFactorSetupRequired: false,
      csrfToken: session.csrfToken,
    });
  } catch (err) {
    return handleError(err);
  }
}
