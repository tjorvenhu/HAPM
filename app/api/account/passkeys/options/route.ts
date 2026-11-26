import { headers } from 'next/headers';
import { requireCsrf, requireVerifiedSession } from '@/lib/session';
import { requirePasskeys, listOwnPasskeys, forwardAuthCookies, authErrorCode } from '@/lib/auth/passkeys';
import { MAX_PASSKEYS_PER_USER } from '@/lib/auth/passkey-rules';
import { rateLimit } from '@/lib/rate-limit';
import { ok, handleError, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { assertDataWritable } from '@/lib/sync/role';

/**
 * Schritt 1 beim Hinterlegen eines Passkeys: die Aufgabe für das Gerät.
 *
 * Der Anmeldedienst verlangt zusätzlich eine frische Sitzung (höchstens einen
 * Tag alt). Das ist gewollt: ein Rechner, der seit Tagen angemeldet herumsteht,
 * soll keinen neuen Zugang zum Konto anlegen können.
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireVerifiedSession();
    await assertDataWritable('accounts');

    const rl = rateLimit(`passkey-register:${session.userId}`, 10, 15 * 60 * 1000);
    if (!rl.success) throw new ApiError(msg('Zu viele Versuche. Bitte warten Sie 15 Minuten.'), 429);

    const passkeys = await requirePasskeys();
    const requestHeaders = await headers();

    const existing = await listOwnPasskeys(passkeys, requestHeaders);
    if (existing.length >= MAX_PASSKEYS_PER_USER) {
      throw new ApiError(
        msg('Mehr als {max} Passkeys je Konto sind nicht möglich. Bitte entfernen Sie zuerst einen.', {
          max: MAX_PASSKEYS_PER_USER,
        }),
        409
      );
    }

    const challenge = await passkeys
      .generatePasskeyRegistrationOptions({
        headers: requestHeaders,
        // Der Name, unter dem das Gerät den Passkey anzeigt: die Adresse des Kontos.
        query: { name: session.email },
        returnHeaders: true,
      })
      .catch((err: unknown) => {
        if (authErrorCode(err) === 'SESSION_NOT_FRESH') return null;
        throw err;
      });

    if (!challenge) {
      throw new ApiError(
        msg('Zu Ihrer Sicherheit melden Sie sich bitte einmal neu an. Danach können Sie den Passkey hinterlegen.'),
        403
      );
    }

    const response = ok({ options: challenge.response });
    forwardAuthCookies(challenge.headers, response);
    return response;
  } catch (err) {
    return handleError(err);
  }
}
