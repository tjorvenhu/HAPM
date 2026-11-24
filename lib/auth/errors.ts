/**
 * Fehler des Anmeldedienstes, als Meldung von HAPM.
 *
 * Better-Auth antwortet mit einem Code und einem englischen Satz. Der Satz geht
 * nie in die Oberfläche: er passt nicht zum Rest und verrät manchmal mehr, als
 * eine Route sagen will. Die Routen fangen die Codes ab, die sie erwarten.
 * Was dann noch bis `handleError` durchkommt, wird hier zu einer Meldung.
 *
 * Ohne Import von Better-Auth: `lib/api.ts` braucht das, und jede Route lädt
 * `lib/api.ts`. Erkannt wird der Fehler wie in `isAPIError` an seinem Namen.
 */

import { msgid } from '../i18n/translate';

interface AuthApiErrorLike {
  name: string;
  statusCode?: number;
  body?: { code?: unknown };
}

function isAuthApiError(err: unknown): err is AuthApiErrorLike {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'APIError';
}

/** Die Codes, die vorkommen können, und was der Benutzer dazu liest. */
const MESSAGES: Readonly<Record<string, string>> = {
  INVALID_EMAIL_OR_PASSWORD: msgid('Ungültige Anmeldedaten.'),
  INVALID_EMAIL: msgid('Ungültige Anmeldedaten.'),
  INVALID_PASSWORD: msgid('Das Passwort stimmt nicht.'),
  USER_NOT_FOUND: msgid('Dieses Konto gibt es nicht mehr.'),
  CREDENTIAL_ACCOUNT_NOT_FOUND: msgid('Dieses Konto gibt es nicht mehr.'),
  INVALID_TOKEN: msgid('Der Link ist ungültig oder abgelaufen. Bitte fordern Sie einen neuen an.'),
  TOKEN_EXPIRED: msgid('Der Link ist ungültig oder abgelaufen. Bitte fordern Sie einen neuen an.'),
  PASSWORD_TOO_SHORT: msgid('Das Passwort muss mindestens 10 Zeichen lang sein.'),
  PASSWORD_TOO_LONG: msgid('Das Passwort ist zu lang.'),
  SESSION_EXPIRED: msgid('Die Sitzung ist abgelaufen. Bitte melden Sie sich neu an.'),
  SESSION_NOT_FRESH: msgid(
    'Zu Ihrer Sicherheit melden Sie sich bitte einmal neu an. Danach können Sie den Passkey hinterlegen.'
  ),
  SESSION_REQUIRED: msgid('Nicht authentifiziert'),
  CHALLENGE_NOT_FOUND: msgid('Die Anfrage an das Gerät ist abgelaufen. Bitte versuchen Sie es noch einmal.'),
  PASSKEY_NOT_FOUND: msgid('Diesen Passkey gibt es nicht mehr.'),
  AUTHENTICATION_FAILED: msgid('Die Anmeldung mit diesem Passkey war nicht möglich.'),
  YOU_ARE_NOT_ALLOWED_TO_REGISTER_THIS_PASSKEY: msgid('Der Passkey konnte nicht hinterlegt werden.'),
  FAILED_TO_VERIFY_REGISTRATION: msgid('Der Passkey konnte nicht hinterlegt werden.'),
  PREVIOUSLY_REGISTERED: msgid('Dieses Gerät hat für Ihr Konto schon einen Passkey.'),
  FAILED_TO_UPDATE_PASSKEY: msgid('Der Name konnte nicht gespeichert werden.'),
};

/** Für jeden anderen Code: abgelehnt, ohne zu sagen, warum. */
const REJECTED = msgid('Der Anmeldedienst hat die Anfrage abgelehnt.');

/**
 * Die Meldung zu einem Fehler des Anmeldedienstes, oder `null`, wenn es keiner
 * ist. Ein Fehler ab 500 ist der Dienst selbst (Datenbank weg): der bleibt ein
 * Fehler des Servers und wird nicht zu „abgelehnt".
 */
export function authErrorMessage(err: unknown): { message: string; status: number } | null {
  if (!isAuthApiError(err)) return null;
  const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
  if (status >= 500) return null;
  const code = typeof err.body?.code === 'string' ? err.body.code : '';
  return { message: Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : REJECTED, status };
}
