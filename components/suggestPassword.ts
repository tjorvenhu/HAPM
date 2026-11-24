/** Zeichen ohne die, die man beim Vorlesen verwechselt (0/O, 1/l/I). */
const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Ein Passwortvorschlag: zufällig, zwanzig Zeichen, in einem Zug kopierbar.
 *
 * An einer Stelle, weil zwei Dialoge ihn für die Passwortsperre eines
 * Reverse-Proxy-Ziels brauchen (das Formular und der Dialog der Sperre) und
 * beide aus demselben Grund: ein Passwort, das jemand für einen anderen
 * ausdenkt, ist in aller Regel eines, das er schon woanders benutzt.
 */
export function suggestPassword(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}
