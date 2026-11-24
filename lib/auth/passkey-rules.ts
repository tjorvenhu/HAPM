/**
 * Passkeys: die Regeln ohne Datenbank und ohne Netz.
 *
 * Ohne Import außer `lib/i18n` (ebenso rein), weil drei Stellen dieselbe Antwort brauchen:
 * `lib/auth/config.ts` (an welche Domain ein Passkey gebunden wird), die Routen
 * (wie ein Name aussehen darf) und die Oberfläche im Browser (Meldungen,
 * Vorschlag für den Namen). Eine Client-Komponente darf nichts importieren, was
 * `lib/db` erreicht, und diese Datei erreicht nichts.
 *
 * Ein Passkey ist ein zusätzlicher Weg neben Passwort und zweitem Faktor. Das
 * Konto behält beides. Bei der Anmeldung zählt er als beide Faktoren zugleich:
 * das Gerät (Besitz) und Fingerabdruck, Gesicht oder PIN (Person).
 *
 * Die Sätze für die Oberfläche sind deutsche Schlüssel (`msgid`): wer sie zeigt,
 * schickt sie durch `t()`.
 */

import { msgid } from '../i18n/translate';

/** So viele Passkeys je Konto. Mehr braucht niemand, und die Liste bleibt lesbar. */
export const MAX_PASSKEYS_PER_USER = 10;

export const PASSKEY_NAME_MAX = 40;

/**
 * Domain und erlaubte Herkunft aus der Adresse von HAPM (`publicUrl` in den
 * Einstellungen). `null`, solange keine eingerichtet ist oder sie nicht über
 * HTTPS läuft: Browser legen Passkeys nur in einem sicheren Kontext an, und
 * eine IP-Adresse nimmt WebAuthn als Domain nicht.
 *
 * ── Der ganze Hostname, nicht die Domain darüber ──
 *
 * Ein Passkey für `example.org` ließe sich von jeder Unterdomäne aus anfragen,
 * also von jedem Dienst, der hinter demselben HAProxy unter dieser Domain
 * läuft. HAPM hat genau eine Adresse, und nur unter der soll ein Gerät den
 * Schlüssel herausgeben.
 *
 * **Ändert sich die Adresse, sind alle hinterlegten Passkeys wertlos.** Ein
 * Passkey gilt nur für die Domain, für die er angelegt wurde. Alle melden sich
 * dann mit Passwort (und Code) an und hinterlegen ihre Passkeys neu.
 */
export function passkeyRelyingParty(publicUrl: string | null | undefined): { rpID: string; origin: string } | null {
  if (!publicUrl) return null;
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  // `origin` trägt Protokoll, Hostname und einen Port, der vom Standard abweicht,
  // aber weder Pfad noch Schrägstrich am Ende. Genau so vergleicht WebAuthn.
  return { rpID: url.hostname, origin: url.origin };
}

/** Was eingerichtet sein muss, bevor es Passkeys gibt. */
export type PasskeyRequirement = 'publicUrl' | 'mail';

export interface PasskeyAvailability {
  available: boolean;
  missing: PasskeyRequirement[];
}

/**
 * Passkeys gibt es nur mit beidem: der Adresse von HAPM und einem SMTP-Konto.
 *
 * Die Adresse, weil an ihrer Domain jeder Passkey hängt. Das SMTP-Konto, weil
 * ein Passkey ein Weg ins Konto ist, der an Passwort und Code vorbeiführt: wird
 * einer hinterlegt oder entfernt, erfährt es der Inhaber per Mail, und wer sein
 * Gerät verliert, braucht den Weg über „Passwort vergessen".
 */
export function passkeyAvailability(input: { publicUrl: string | null; mailConfigured: boolean }): PasskeyAvailability {
  const missing: PasskeyRequirement[] = [];
  if (!passkeyRelyingParty(input.publicUrl)) missing.push('publicUrl');
  if (!input.mailConfigured) missing.push('mail');
  return { available: missing.length === 0, missing };
}

/** Der Name, den jemand seinem Passkey gibt: ohne Steuerzeichen, gekürzt, nie leer. */
export function cleanPasskeyName(input: string | null | undefined): string {
  const cleaned = String(input ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PASSKEY_NAME_MAX)
    .trim();
  return cleaned || 'Passkey';
}

/**
 * Ein Vorschlag für den Namen aus der Kennung des Browsers, damit das Feld nicht
 * leer beginnt. Grob und ohne Anspruch: der Benutzer kann ihn überschreiben.
 */
export function suggestPasskeyName(userAgent: string | null | undefined): string {
  const ua = userAgent ?? '';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return msgid('Android-Gerät');
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return msgid('Windows-PC');
  if (/Linux/.test(ua)) return msgid('Linux-PC');
  return 'Passkey';
}

/**
 * Wo der Passkey liegt, in einem Satz für die Liste.
 *
 * `backedUp` heißt: mit der Cloud des Herstellers abgeglichen (iCloud-Schlüsselbund,
 * Google-Passwortmanager) und damit auf allen Geräten dieses Kontos vorhanden.
 * Ohne Abgleich lebt er nur auf dem einen Gerät oder Sicherheitsschlüssel.
 */
export function passkeyStorageLabel(passkey: { deviceType: string; backedUp: boolean }): string {
  if (passkey.backedUp) return msgid('Auf Ihren Geräten abgeglichen');
  return passkey.deviceType === 'multiDevice'
    ? msgid('Abgleich möglich, noch nicht gesichert')
    : msgid('Nur auf einem Gerät');
}

/**
 * Die Meldung zu einem Fehler, den der Browser beim Anlegen oder Benutzen wirft.
 *
 * `NotAllowedError` kommt bei jedem Abbruch: Fenster geschlossen, Zeit abgelaufen,
 * falscher Finger. Der Browser sagt absichtlich nicht, was es war, also tut es
 * diese Meldung auch nicht.
 */
export function passkeyBrowserError(name: string | undefined, purpose: 'register' | 'login'): string {
  switch (name) {
    case 'NotAllowedError':
    case 'AbortError':
      return purpose === 'login' ? msgid('Die Anmeldung wurde abgebrochen.') : msgid('Das Anlegen wurde abgebrochen.');
    case 'InvalidStateError':
      return msgid('Dieses Gerät hat für Ihr Konto schon einen Passkey.');
    case 'NotSupportedError':
      return msgid('Dieses Gerät kann keinen Passkey anlegen, der Sie per Fingerabdruck, Gesicht oder PIN bestätigt.');
    case 'SecurityError':
      return msgid('Passkeys funktionieren nur unter der eingerichteten Adresse von HAPM und über eine sichere Verbindung.');
    default:
      return purpose === 'login'
        ? msgid('Die Anmeldung mit Passkey ist fehlgeschlagen.')
        : msgid('Der Passkey konnte nicht angelegt werden.');
  }
}
