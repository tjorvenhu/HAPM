// @ts-check
/**
 * Passwort und Hash für `hapm-admin reset-password`.
 *
 * Eine eigene Datei, damit `tests/auth/admin-password.test.ts` prüfen kann, was
 * sonst erst beim nächsten vergessenen Passwort auffiele: dass der
 * Anmeldedienst den Hash annimmt, den dieses Skript schreibt.
 *
 * Der Hash ist der von Better-Auth (`@better-auth/utils/password`): scrypt mit
 * N=16384, r=16, p=1 über 64 Byte, das Passwort NFKC-normalisiert, das Salz als
 * Hex-Text (nicht als Bytes), Ergebnis `salz:hash` in Hex. Nachgebaut statt
 * importiert, weil das Skript ohne Build im Container läuft und dort nur liegt,
 * was der Server zur Laufzeit lädt.
 */

import { randomBytes, scrypt } from 'node:crypto';

const SCRYPT = { N: 16384, r: 16, p: 1, keyLength: 64 };

/**
 * @param {string} password
 * @returns {Promise<string>}
 */
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      SCRYPT.keyLength,
      // Mit r=16 braucht scrypt mehr Speicher, als Node ohne Angabe zulässt.
      { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2 },
      (err, key) => (err ? reject(err) : resolve(`${salt}:${key.toString('hex')}`))
    );
  });
}

/** Ein Passwort, das die Regeln der Oberfläche erfüllt und sich abtippen lässt. */
export function newPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (const byte of randomBytes(20)) out += alphabet[byte % alphabet.length];
  return `${out}Aa1`;
}
