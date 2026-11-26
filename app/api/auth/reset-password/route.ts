import { isAPIError } from 'better-auth/api';
import { auth } from '@/lib/auth/config';
import { logAudit, getClientIP } from '@/lib/audit';
import { rateLimit } from '@/lib/rate-limit';
import { validatePassword } from '@/lib/validation';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { assertDataWritable } from '@/lib/sync/role';

const INVALID = msg('Der Link ist ungültig oder abgelaufen. Bitte fordern Sie einen neuen an.');

/**
 * Passwort neu setzen: durchgereicht an `resetPassword`.
 *
 * Das Einlösen des Tokens (er gilt genau einmal) und das Schreiben des neuen
 * Hashes macht der Anmeldedienst, und er beendet dabei alle Sitzungen des
 * Kontos (`revokeSessionsOnPasswordReset`, Vorgabe in `lib/auth/core`).
 *
 * `validatePassword` bleibt davor: Better-Auth prüft nur die Länge, die Regel
 * von HAPM verlangt mehr. Ein Passwort, das beim Anlegen eines Kontos nicht
 * durchginge, soll nicht über „vergessen" hineinkommen.
 *
 * Der zweite Faktor und die Passkeys des Kontos bleiben bestehen: der Link kam
 * an die Adresse des Kontos, mehr als das Passwort ersetzt er nicht.
 */
export async function POST(request: Request) {
  try {
    const ip = getClientIP(request);
    if (ip !== 'unknown') {
      const rl = rateLimit(`reset-password:${ip}`, 5, 15 * 60 * 1000);
      if (!rl.success) throw new ApiError(msg('Zu viele Versuche. Bitte warten Sie 15 Minuten.'), 429);
    }
    await assertDataWritable('accounts');

    const { token, newPassword } = await jsonBody<{ token?: unknown; newPassword?: unknown }>(request);
    if (typeof token !== 'string' || typeof newPassword !== 'string' || !token || !newPassword) {
      throw new ApiError(msg('Der Link und das neue Passwort sind erforderlich.'));
    }

    const passwordError = validatePassword(newPassword);
    if (passwordError) throw new ApiError(passwordError);

    const reset = await (await auth())
      .api.resetPassword({ body: { token, newPassword } })
      .catch((err: unknown) => {
        // Nur ein untauglicher Token wird zur freundlichen Meldung. Eine nicht
        // erreichbare Datenbank darf nicht als „Link abgelaufen" enden.
        if (isAPIError(err) && err.body?.code === 'INVALID_TOKEN') return null;
        throw err;
      });

    if (!reset) throw new ApiError(INVALID);

    // Ohne Konto im Eintrag: `resetPassword` nennt es nicht, und der Token ist
    // an dieser Stelle schon verbraucht.
    await logAudit({
      userId: '',
      userEmail: '',
      action: 'password_reset_completed',
      ip,
      details: 'Über den Link aus der Mail',
    });

    return ok();
  } catch (err) {
    return handleError(err);
  }
}
