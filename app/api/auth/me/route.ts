import { getSession } from '@/lib/session';
import { getUserLocale } from '@/lib/auth/users';
import { ok, handleError, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { crowdsecInstalled, crowdsecPresent } from '@/lib/crowdsec/paths';

/**
 * Die Sitzung, in der Form, die `ToolShell` (`ui/tool/ToolShell.tsx`) liest: ohne
 * Sitzung 401, mit `twoFactorPending` zurück zur Anmeldung. `locale` ist die
 * Sprache am Konto, `AppShell` stellt die Oberfläche darauf um.
 */
export async function GET() {
  try {
    const session = await getSession();
    if (!session.userId) throw new ApiError(msg('Nicht authentifiziert'), 401);

    return ok({
      userId: session.userId,
      email: session.email,
      name: session.name,
      twoFactorPending: !session.twoFactorVerified,
      twoFactorSetupRequired: false,
      csrfToken: session.csrfToken,
      locale: await getUserLocale(session.userId),
      // Abgewählt oder von vor CrowdSec: dann blendet die Oberfläche es aus.
      features: { crowdsec: crowdsecInstalled(), crowdsecPresent: crowdsecPresent() },
    });
  } catch (err) {
    return handleError(err);
  }
}
