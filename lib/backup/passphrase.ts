/**
 * Der Sicherungsschlüssel: die Passphrase, mit der ein Archiv verschlüsselt
 * wird. Hier nur die Regeln, rein (nur `lib/i18n`), damit die Seite sie
 * benutzen darf. Verschlüsselt und entschlüsselt wird in `./run.ts` (im
 * Helfer) und `./decrypt.ts`.
 *
 * ── Warum „Sicherungsschlüssel" und nicht „Schlüssel" ──
 *
 * „Schlüssel" heißt auf der Seite schon `encryptionKey` aus `secrets.json`,
 * der mit ins Archiv geht. Der Sicherungsschlüssel ist das Gegenteil davon: er
 * steht in keinem Archiv und muss getrennt aufbewahrt werden.
 *
 * ── Das Verfahren ──
 *
 * `gpg --symmetric` (OpenPGP, AES-256, Integritätsschutz über MDC), die Datei
 * heißt danach `….tar.gz.gpg`. Gewählt, weil sich so ein Archiv auf jedem
 * Linux ohne HAPM entschlüsseln lässt (`gpg -o x.tar.gz -d x.tar.gz.gpg`):
 * `docs/betrieb.md` beschreibt das Zurückspielen von Hand, und ein eigenes
 * Format wäre dort ein Werkzeug, das im Ernstfall fehlt. `openssl enc` kennt
 * keinen Integritätsschutz.
 *
 * ── Die Regeln für den Text ──
 *
 * gpg liest den Schlüssel als eine Zeile, aus einer Datei oder von stdin.
 * Deshalb kein Zeilenumbruch und keine Steuerzeichen. Leerraum am Anfang oder
 * Ende wird abgelehnt und nicht stillschweigend entfernt: wer ihn von Hand in
 * gpg eintippt, tippt ihn sonst anders als gespeichert.
 */

import { msg, type Message } from '../i18n';

export const PASSPHRASE_MIN = 12;
export const PASSPHRASE_MAX = 200;

/** Die Endung eines verschlüsselten Archivs, hinter `.tar.gz`. */
export const ENCRYPTED_SUFFIX = '.gpg';

export function isEncryptedName(name: string): boolean {
  return name.endsWith(`.tar.gz${ENCRYPTED_SUFFIX}`);
}

/** Der Schlüssel, wie er gespeichert wird, oder die Meldung für den Benutzer. */
export function checkPassphrase(input: unknown): { passphrase: string } | { error: Message } {
  if (typeof input !== 'string' || input === '') return { error: msg('Der Sicherungsschlüssel fehlt.') };
  if (/[\u0000-\u001f\u007f]/.test(input)) {
    return { error: msg('Der Sicherungsschlüssel darf keine Zeilenumbrüche und keine Steuerzeichen enthalten.') };
  }
  if (input !== input.trim()) {
    return { error: msg('Der Sicherungsschlüssel darf nicht mit einem Leerzeichen beginnen oder enden.') };
  }
  if (input.length < PASSPHRASE_MIN) {
    return { error: msg('Der Sicherungsschlüssel braucht mindestens {min} Zeichen.', { min: PASSPHRASE_MIN }) };
  }
  if (input.length > PASSPHRASE_MAX) {
    return { error: msg('Der Sicherungsschlüssel darf höchstens {max} Zeichen lang sein.', { max: PASSPHRASE_MAX }) };
  }
  return { passphrase: input };
}
