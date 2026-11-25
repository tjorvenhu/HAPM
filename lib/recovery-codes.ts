/**
 * Wiederherstellungscodes des zweiten Faktors: erzeugen, für die Datenbank
 * hashen, eine Eingabe gegen die Hashes prüfen. Ohne Datenbank, die Funktionen
 * sind rein (bis auf den Schlüssel aus `secrets()`). Wer sie ablegt und
 * verbraucht, steht in `lib/two-factor.ts`.
 *
 * ── Vorbild und Abweichungen ──
 *
 * Wie im Zwei-Faktor-Plugin von Better-Auth: zehn Codes,
 * je zehn Zeichen, angezeigt als `xxxxx-xxxxx`. Zwei Abweichungen:
 *
 * - **Nur Kleinbuchstaben und Ziffern, ohne 0, o, 1, l und i.** Die Codes
 *   werden von Papier abgetippt, oft Jahre später. Groß und klein zu
 *   unterscheiden, oder `l` und `1`, kostet dort mehr Fehlversuche, als die
 *   zusätzlichen Bits wert sind. Die Eingabe wird klein geschrieben und ohne
 *   Leerzeichen und Bindestriche verglichen. 31¹⁰ sind gut 49 Bit je Code;
 *   online begrenzt das Rate-Limit der Anmeldung.
 *
 * - **Gehasht statt verschlüsselt.** Better-Auth legt die Codes verschlüsselt
 *   ab, weil es sie später noch einmal anzeigen kann. HAPM zeigt sie genau
 *   einmal und braucht danach nur noch die Frage „ist dieser Code dabei?“.
 *   HMAC-SHA256 statt eines nackten SHA-256: der Schlüssel liegt im
 *   Daten-Volume (`secrets.json`), nicht in der Datenbank. Ein Abzug der
 *   Tabelle allein erlaubt also nicht einmal das Durchprobieren. Kein scrypt
 *   wie beim Passwort: die Codes sind zufällig und lang genug, und bei jeder
 *   Eingabe werden bis zu zehn Hashes gebildet.
 *
 * Der Schlüssel ist aus `encryptionKey` abgeleitet, nicht aus `sessionSecret`:
 * wer das Sitzungsgeheimnis erneuert, will alle abmelden, nicht still alle
 * Wiederherstellungscodes ungültig machen.
 */

import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { secrets } from './secrets';

export const RECOVERY_CODE_COUNT = 10;
const CODE_LENGTH = 10;
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function digest(plain: string): string {
  return createHmac('sha256', `hapm-recovery-codes:${secrets().encryptionKey}`).update(plain).digest('hex');
}

/** `randomInt` und nicht `randomBytes % 31`: das wäre nicht gleichverteilt. */
function randomCode(): string {
  let raw = '';
  for (let i = 0; i < CODE_LENGTH; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/** Neue Codes im Klartext, zum einmaligen Anzeigen. Keine zwei gleichen. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) codes.add(randomCode());
  return [...codes];
}

/**
 * Die Eingabe in der Form, in der sie gehasht wird, oder `null`, wenn sie kein
 * Wiederherstellungscode sein kann. Bindestrich, Leerzeichen und Großschreibung
 * zählen nicht.
 */
export function normaliseRecoveryCode(input: string): string | null {
  const plain = input.toLowerCase().replace(/[\s-]/g, '');
  return new RegExp(`^[a-z0-9]{${CODE_LENGTH}}$`).test(plain) ? plain : null;
}

/** Der Hash eines Codes, hex. Wirft bei einer Eingabe, die kein Code sein kann. */
export function hashRecoveryCode(code: string): string {
  const plain = normaliseRecoveryCode(code);
  if (!plain) throw new Error('Kein Wiederherstellungscode');
  return digest(plain);
}

/**
 * Welcher der gespeicherten Hashes zur Eingabe passt, als Index, sonst `-1`.
 *
 * Jeder Hash wird verglichen, auch nach einem Treffer, und jeder Vergleich ist
 * zeitkonstant: die Laufzeit sagt nichts darüber, ob oder an welcher Stelle
 * der Code stand.
 */
export function findRecoveryCode(hashes: readonly string[], input: string): number {
  const plain = normaliseRecoveryCode(input);
  if (!plain) return -1;
  const candidate = Buffer.from(digest(plain));
  let found = -1;
  hashes.forEach((hash, index) => {
    const stored = Buffer.from(hash);
    const equal = stored.length === candidate.length && timingSafeEqual(stored, candidate);
    if (equal && found === -1) found = index;
  });
  return found;
}
