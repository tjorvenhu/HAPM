import { isAPIError } from 'better-auth/api';
import { auth, sessionHeaders } from '@/lib/auth/config';
import { forwardAuthCookies } from '@/lib/auth/passkeys';
import { getUserLocale, recordLogin } from '@/lib/auth/users';
import { csrfFor } from '@/lib/session';
import { has2FAEnabled, clear2FACookie } from '@/lib/two-factor';
import { logAudit, getClientIP } from '@/lib/audit';
import { clearFailures, failuresBlocked, rateLimit, recordFailure } from '@/lib/rate-limit';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { setLocaleCookie } from '@/lib/i18n/server';

/**
 * Der Passwortschritt der Anmeldung, über den Anmeldedienst.
 *
 * Ohne eingerichteten zweiten Faktor ist die Sitzung danach vollständig. Mit
 * ihm bleibt sie eine Teil-Sitzung, bis `/api/auth/2fa/validate` den Code
 * gesehen hat. Der CSRF-Token steht in der Antwort, weil der Cookie mit der
 * neuen Sitzung erst mit dieser Antwort beim Browser ankommt.
 *
 * Better-Auth hasht bei unbekanntem Konto ins Leere und antwortet in allen
 * Fällen (Konto fehlt, falsches Passwort) gleich: die Antwort verrät nicht, ob
 * es ein Konto gibt.
 *
 * Zwei Dinge tut die Route zusätzlich. Sie räumt den Nachweis des zweiten
 * Faktors ab: wer sein Passwort eingibt, zeigt danach auch seinen Code. Und sie
 * reicht die Cookies der Sitzung von Hand weiter, denn `auth().api.*` schreibt
 * sie in die eigenen Antwortkopfzeilen, nicht in unsere.
 */
const WINDOW_MS = 15 * 60 * 1000;
const TOO_MANY = msg('Zu viele Anmeldeversuche. Bitte warten Sie 15 Minuten.');

/**
 * Fehlversuche je Konto und Tag. Die Grenzen oben bremsen nur: zehn Versuche je
 * Viertelstunde sind am Tag fast tausend. Wer über viele Adressen ein Passwort
 * rät, hat mit dieser Grenze am Tag dreißig Versuche. Gezählt wird, was als
 * E-Mail eingegeben wurde, ob es das Konto gibt oder nicht: die Antwort verrät
 * so nichts. Eine gelungene Anmeldung leert den Zähler. Passkeys und
 * `hapm-admin reset-password` gehen an der Sperre vorbei.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const FAILURES_PER_DAY = 30;
const LOCKED = msg('Zu viele Fehlversuche für dieses Konto. Die Anmeldung mit Passwort ist bis zu 24 Stunden gesperrt.');

/**
 * Die Fehlercodes, die „Anmeldedaten stimmen nicht" heißen, und nur die. Eine
 * nicht erreichbare Datenbank ist kein falsches Passwort und fliegt weiter.
 */
const CREDENTIAL_ERRORS = new Set(['INVALID_EMAIL_OR_PASSWORD', 'INVALID_EMAIL']);

export async function POST(request: Request) {
  try {
    const ip = getClientIP(request);

    // Ohne den Vorlader (`pnpm dev`) kennt die Anfrage keine Adresse. Ein Zähler
    // unter „unknown" sperrte dann alle gemeinsam aus.
    if (ip !== 'unknown') {
      const rl = rateLimit(`login:${ip}`, 5, WINDOW_MS);
      if (!rl.success) throw new ApiError(TOO_MANY, 429);
    }

    const { email, password } = await jsonBody<{ email?: unknown; password?: unknown }>(request);
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      throw new ApiError(msg('E-Mail und Passwort sind erforderlich.'));
    }

    // Zusätzlich je Konto: wer über viele Adressen kommt, hat je Adresse fünf
    // Versuche, auf dasselbe Konto aber zusammen nur zehn.
    const account = email.trim().toLowerCase().slice(0, 254);
    const failureKey = `login-failures:${account}`;
    if (failuresBlocked(failureKey, FAILURES_PER_DAY, DAY_MS).blocked) throw new ApiError(LOCKED, 429);
    const perAccount = rateLimit(`login-account:${account}`, 10, WINDOW_MS);
    if (!perAccount.success) throw new ApiError(TOO_MANY, 429);

    const signIn = await (await auth())
      .api.signInEmail({
        body: { email: email.trim(), password },
        headers: await sessionHeaders(request),
        returnHeaders: true,
      })
      .catch((err: unknown) => {
        if (isAPIError(err) && CREDENTIAL_ERRORS.has(err.body?.code ?? '')) return null;
        throw err;
      });

    if (!signIn) {
      recordFailure(failureKey);
      await logAudit({
        userId: '',
        userEmail: email.slice(0, 254),
        action: 'login_failed',
        ip,
        details: 'Ungültige Anmeldedaten',
      });
      throw new ApiError(msg('Ungültige Anmeldedaten.'), 401);
    }

    clearFailures(failureKey);
    const { token, user } = signIn.response;
    const has2FA = await has2FAEnabled(user.id);

    await clear2FACookie();
    // Mit zweitem Faktor zählt die Anmeldung erst, wenn der Code stimmt.
    if (!has2FA) await recordLogin(user.id);

    await logAudit({
      userId: user.id,
      userEmail: user.email,
      action: 'login',
      ip,
      details: has2FA ? 'Passwort stimmt, zweiter Faktor steht aus' : undefined,
    });

    const response = ok({ requiresTwoFactor: has2FA, csrfToken: csrfFor(token) });
    forwardAuthCookies(signIn.headers, response);
    // Die Sprache am Konto gilt ab jetzt auch für die Seiten, die das Cookie lesen.
    setLocaleCookie(response, await getUserLocale(user.id));
    return response;
  } catch (err) {
    return handleError(err);
  }
}
