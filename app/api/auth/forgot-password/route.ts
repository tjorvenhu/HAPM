import { auth } from '@/lib/auth/config';
import { mailConfigured } from '@/lib/mail';
import { getSettings } from '@/lib/settings';
import { logAudit, getClientIP } from '@/lib/audit';
import { rateLimit } from '@/lib/rate-limit';
import { validateEmail } from '@/lib/validation';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';

/**
 * Passwort vergessen: durchgereicht an `requestPasswordReset`.
 *
 * Token (in `auth_verifications`, eine Stunde gültig, einmal verwendbar) und
 * Mail macht der Anmeldedienst, die Mail geht über `sendAuthMail` und damit
 * über das SMTP-Konto aus den Einstellungen.
 *
 * Drei Eigenschaften hängen an dieser Route:
 *
 *  - **Dieselbe Antwort, ob es das Konto gibt oder nicht.** Der `catch` unten
 *    hält das durch: die Mail geht nur für ein vorhandenes Konto hinaus, ein
 *    gemeldeter Versandfehler wäre also die Auskunft, dass es eines gibt.
 *  - **Die Begrenzung**, je Aufrufer und je Adresse: der Versand kostet eine
 *    Mail an einen echten Posteingang.
 *  - **Ohne Adresse von HAPM oder ohne SMTP-Konto geht es nicht.** Das sagt die
 *    Route offen, es ist eine Auskunft über die Installation und nicht über
 *    ein Konto. Der Weg ist dann `hapm-admin reset-password` auf dem Server.
 */
const WINDOW_MS = 15 * 60 * 1000;
const TOO_MANY = msg('Zu viele Anfragen. Bitte warten Sie 15 Minuten.');

export async function POST(request: Request) {
  try {
    const ip = getClientIP(request);
    if (ip !== 'unknown') {
      const rl = rateLimit(`forgot-password:${ip}`, 3, WINDOW_MS);
      if (!rl.success) throw new ApiError(TOO_MANY, 429);
    }

    const { email } = await jsonBody<{ email?: unknown }>(request);
    if (typeof email !== 'string' || !validateEmail(email.trim())) {
      throw new ApiError(msg('Bitte geben Sie eine gültige E-Mail-Adresse ein.'));
    }
    const address = email.trim().toLowerCase();

    const perAccount = rateLimit(`forgot-password-account:${address.slice(0, 254)}`, 3, WINDOW_MS);
    if (!perAccount.success) throw new ApiError(TOO_MANY, 429);

    const [settings, mail] = await Promise.all([getSettings(), mailConfigured()]);
    if (!settings.publicUrl || !mail) {
      throw new ApiError(
        msg('Das Zurücksetzen per E-Mail ist auf dieser Installation nicht eingerichtet. Ein neues Passwort setzt auf dem Server: docker exec -it hapm hapm-admin reset-password <e-mail>'),
        409
      );
    }

    try {
      await (await auth()).api.requestPasswordReset({ body: { email: address } });
    } catch (resetErr) {
      console.error('[forgot-password] Anforderung fehlgeschlagen:', resetErr);
    }

    await logAudit({
      userId: '',
      userEmail: address,
      action: 'password_reset_requested',
      ip,
    });

    return ok();
  } catch (err) {
    return handleError(err);
  }
}
