/**
 * Passkeys: was die Routen vom Anmeldedienst brauchen.
 *
 * Ein Passkey ist ein zusätzlicher Weg neben Passwort und zweitem Faktor. Das
 * Konto behält beides: wer sein Gerät verliert, meldet sich wie bisher an und
 * entfernt den Passkey unter „Konto". Bei der Anmeldung zählt er als beide
 * Faktoren zugleich, das Gerät (Besitz) und Fingerabdruck, Gesicht oder PIN
 * (Person). `./core` nimmt deshalb nur Passkeys an, bei denen das Gerät die
 * Person geprüft hat.
 *
 * Die Tabellen des Anmeldedienstes fasst keine Route selbst an. Die eigenen
 * Passkeys liest und schreibt ein Konto ausschließlich über die Endpunkte des
 * Plugins, und die prüfen bei jedem Aufruf, dass der Passkey dem Konto der
 * Sitzung gehört.
 *
 * ── Was HAPM dazu verlangt ──
 *
 * Passkeys gibt es nur, wenn die Adresse von HAPM und ein SMTP-Konto
 * eingerichtet sind (`passkey-rules.ts`). Jede Route fragt das über
 * `requirePasskeys()` ab, bevor sie etwas tut: fehlt eines von beiden, gibt es
 * weder Anmeldung noch Verwaltung, auch wenn noch Passkeys hinterlegt sind.
 */

import { isAPIError } from 'better-auth/api';
import { ApiError } from '../api';
import { msg } from '../i18n';
import { mailConfigured } from '../mail';
import { getSettings } from '../settings';
import { auth } from './config';
import { passkeyApi, PASSKEY_NEEDS_USER_VERIFICATION, type PasskeyApi } from './core';
import {
  cleanPasskeyName,
  passkeyAvailability,
  passkeyStorageLabel,
  type PasskeyAvailability,
} from './passkey-rules';

export async function passkeyStatus(): Promise<PasskeyAvailability> {
  const [settings, mail] = await Promise.all([getSettings(), mailConfigured()]);
  return passkeyAvailability({ publicUrl: settings.publicUrl, mailConfigured: mail });
}

/** Die Absage je nachdem, was fehlt. Ganze Sätze, damit jeder einen Eintrag im Wörterbuch hat. */
function missingMessage(missing: PasskeyAvailability['missing']) {
  if (missing.includes('publicUrl') && missing.includes('mail')) {
    return msg('Passkeys stehen erst zur Verfügung, wenn die Adresse von HAPM und ein SMTP-Konto eingerichtet sind.');
  }
  if (missing.includes('publicUrl')) {
    return msg('Passkeys stehen erst zur Verfügung, wenn die Adresse von HAPM eingerichtet ist.');
  }
  return msg('Passkeys stehen erst zur Verfügung, wenn ein SMTP-Konto eingerichtet ist.');
}

/** Die Passkey-Endpunkte, oder eine Absage, die sagt, was fehlt. */
export async function requirePasskeys(): Promise<PasskeyApi> {
  const status = await passkeyStatus();
  if (!status.available) throw new ApiError(missingMessage(status.missing), 409);
  return passkeyApi(await auth());
}

/**
 * Ein Passkey, wie die Oberfläche ihn zeigt. Der öffentliche Schlüssel und die
 * Kennung des Geräts stehen nicht darin: die Liste braucht sie nicht.
 */
export interface PasskeyView {
  id: string;
  name: string;
  /** Wo er liegt, als fertiger Satz: ein deutscher Schlüssel, die Oberfläche übersetzt ihn. */
  storage: string;
  /** ISO 8601, die Anzeige formatiert in der Sprache der Oberfläche. */
  createdAt: string | null;
}

/** Die Passkeys des Kontos, zu dem die Sitzung in `headers` gehört. Älteste zuerst. */
export async function listOwnPasskeys(api: PasskeyApi, headers: Headers): Promise<PasskeyView[]> {
  const rows = await api.listPasskeys({ headers });
  return rows
    .map((row) => ({
      id: row.id,
      name: cleanPasskeyName(row.name),
      storage: passkeyStorageLabel(row),
      createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    }))
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
}

/** Der Fehlercode einer Antwort des Anmeldedienstes. Der englische Text daneben geht nie in die Oberfläche. */
export function authErrorCode(err: unknown): string | null {
  if (!isAPIError(err)) return null;
  const code = (err.body as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : null;
}

/**
 * Hat der Anmeldedienst die Anfrage abgelehnt, oder ist er selbst gescheitert?
 * Eine nicht erreichbare Datenbank ist kein abgelehnter Passkey. Abgelehnt ist
 * alles unter 500, der Rest fliegt weiter nach oben.
 */
export function isAuthRejection(err: unknown): boolean {
  return isAPIError(err) && err.statusCode < 500;
}

/** Das Gerät hat die Person nicht geprüft (kein Fingerabdruck, Gesicht oder PIN). */
export function isMissingUserVerification(err: unknown): boolean {
  if (!isAPIError(err)) return false;
  return (err.body as { message?: unknown } | undefined)?.message === PASSKEY_NEEDS_USER_VERIFICATION;
}

/**
 * Die `Set-Cookie`-Zeilen einer Antwort des Anmeldedienstes an die eigene Antwort hängen.
 *
 * `auth().api.*` schreibt seine Cookies in die eigenen Antwortkopfzeilen. Bei
 * Passkeys hängt daran mehr als die Sitzung: der Dienst merkt sich die Aufgabe
 * für das Gerät hinter einem signierten Cookie, und ohne ihn findet der zweite
 * Schritt die Aufgabe nicht.
 */
export function forwardAuthCookies(from: Headers, to: Response): void {
  for (const cookie of from.getSetCookie()) {
    to.headers.append('set-cookie', cookie);
  }
}
