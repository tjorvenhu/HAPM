import { sessionHeaders } from '@/lib/auth/config';
import {
  requirePasskeys,
  forwardAuthCookies,
  authErrorCode,
  isAuthRejection,
  isMissingUserVerification,
} from '@/lib/auth/passkeys';
import { getUserLocale, recordLogin } from '@/lib/auth/users';
import { set2FACookie } from '@/lib/two-factor';
import { logAudit, getClientIP } from '@/lib/audit';
import { rateLimit } from '@/lib/rate-limit';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { setLocaleCookie } from '@/lib/i18n/server';

/**
 * Schritt 2 der Anmeldung mit Passkey: die Antwort des Geräts prüfen.
 *
 * ── Warum hier der Nachweis des zweiten Faktors entsteht ──
 *
 * Eine Anmeldung mit Passkey ersetzt Passwort und Code in einem Schritt. Das
 * Gerät ist der Besitz, Fingerabdruck, Gesicht oder PIN sind die Person. Nach
 * dem Erfolg stellt die Route deshalb denselben Nachweis aus wie
 * `/api/auth/2fa/validate` nach einem gültigen Code, sonst verlangte die
 * nächste Seite den Code doch.
 *
 * **Das ist nur richtig, weil `lib/auth/core` jede Antwort ablehnt, bei der das
 * Gerät die Person nicht geprüft hat.** WebAuthn überlässt das dem Aufrufer:
 * ohne diese Prüfung genügt es, einen Sicherheitsschlüssel zu berühren, und das
 * ist ein Faktor. Wer die Prüfung dort lockert, muss `set2FACookie` hier mit
 * entfernen.
 *
 * Fünf Versuche in 15 Minuten je Adresse, wie bei der Anmeldung mit Passwort.
 * Erraten lässt sich ein Passkey nicht, aber jeder abgelehnte Versuch schreibt
 * eine Zeile ins Protokoll, und die Route ist ohne Sitzung erreichbar.
 */
export async function POST(request: Request) {
  try {
    const ip = getClientIP(request);
    if (ip !== 'unknown') {
      const rl = rateLimit(`passkey-login:${ip}`, 5, 15 * 60 * 1000);
      if (!rl.success) throw new ApiError(msg('Zu viele Anmeldeversuche. Bitte warten Sie 15 Minuten.'), 429);
    }

    const passkeys = await requirePasskeys();

    const { response: assertion } = await jsonBody<{ response?: unknown }>(request);
    if (!assertion || typeof assertion !== 'object' || Array.isArray(assertion)) {
      throw new ApiError(msg('Die Antwort des Geräts war unvollständig.'));
    }

    const signIn = await passkeys
      .verifyPasskeyAuthentication({
        body: { response: assertion as Record<string, unknown> },
        headers: await sessionHeaders(request),
        returnHeaders: true,
      })
      .catch((err: unknown) => {
        if (isAuthRejection(err)) return { rejected: err };
        throw err;
      });

    if ('rejected' in signIn) {
      const noUserVerification = isMissingUserVerification(signIn.rejected);
      // Zu wem der Passkey gehört hätte, steht nur in einer ungeprüften Antwort.
      // Ins Protokoll kommt deshalb kein Name, den der Anfragende selbst wählt.
      await logAudit({
        userId: '',
        userEmail: 'unbekannt',
        action: 'login_failed',
        ip,
        details: noUserVerification
          ? 'Passkey ohne Bestätigung der Person abgelehnt'
          : `Passkey abgelehnt (${authErrorCode(signIn.rejected) ?? 'ohne Code'})`,
      });
      if (noUserVerification) {
        throw new ApiError(
          msg('Dieser Passkey bestätigt Sie nicht per Fingerabdruck, Gesicht oder PIN und wird deshalb nicht angenommen.'),
          401
        );
      }
      // Ob es den Passkey nicht (mehr) gibt, die Aufgabe abgelaufen ist oder die
      // Prüfung scheiterte, wird nach außen nicht unterschieden.
      throw new ApiError(msg('Die Anmeldung mit diesem Passkey war nicht möglich.'), 401);
    }

    const { user, session } = signIn.response;
    // Das Plugin gibt die ganze Zeile der Sitzung zurück, der Typ nennt nur zwei Felder.
    const token = (session as { token?: unknown }).token;
    if (typeof token !== 'string' || !token) {
      throw new Error('Die Anmeldung mit Passkey hat keine Sitzung geliefert.');
    }

    await set2FACookie(user.id, token);
    await recordLogin(user.id);

    await logAudit({
      userId: user.id,
      userEmail: user.email,
      action: 'login',
      ip,
      details: 'Passkey',
    });

    const response = ok();
    forwardAuthCookies(signIn.headers, response);
    setLocaleCookie(response, await getUserLocale(user.id));
    return response;
  } catch (err) {
    return handleError(err);
  }
}
