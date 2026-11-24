/**
 * Aus einem Passwort wird, was in `haproxy.cfg` steht.
 *
 * Getrennt von `config.ts`, weil dieses Modul `node:crypto` braucht und jenes
 * ohne einen einzigen Import auskommen muss (Formular und Route teilen es).
 * Hier entsteht die Sperre, dort wird sie geschrieben und zurückgelesen.
 *
 * Das Passwort selbst wird nirgends abgelegt: nicht in der Datenbank, nicht in
 * der Historie, nicht im Audit. Wer es vergisst, setzt ein neues.
 */

import { createHash, randomBytes } from 'node:crypto';
import { ApiError } from '../api';
import {
  KEEP_PASSWORD,
  readServiceInput,
  validateLockPassword,
  type CreateServiceInput,
  type PasswordLock,
} from './config';

/**
 * Der Hash, wie HAProxy ihn nachrechnet: SHA-256 über die UTF-8-Bytes des
 * Passworts, gefolgt vom Salz (`…,url_dec(1),concat(<salz>),sha2(256),hex,lower`).
 *
 * NFC, weil der Browser das Feld so schickt, wie es getippt wurde, und das ist
 * auf den üblichen Tastaturen die zusammengesetzte Form. Ein hier zerlegt
 * ankommendes „ä" ergäbe sonst einen anderen Hash als dasselbe getippte.
 */
export function hashLockPassword(password: string, salt: string): string {
  return createHash('sha256')
    .update(password.normalize('NFC') + salt, 'utf8')
    .digest('hex');
}

/** Eine neue Sperre: frisches Salz und ein frischer Cookie-Wert. Wer vorher
 *  durchgelassen war, muss das neue Passwort eingeben. */
export function createPasswordLock(password: string): PasswordLock {
  const salt = randomBytes(16).toString('hex');
  return {
    salt,
    hash: hashLockPassword(password, salt),
    token: randomBytes(32).toString('hex'),
  };
}

/**
 * Ein Dienst aus einem Request-Rumpf, samt dem Passwort seiner Sperre.
 *
 * `readServiceInput` setzt an die Stelle der Sperre nur den Verweis
 * `KEEP_PASSWORD`. Kam ein `lockPassword` mit, wird daraus hier die Sperre. Kam
 * keins mit, bleibt der Verweis: beim Ändern setzt `replaceService` das
 * Passwort ein, das schon in der Datei steht, und beim Anlegen lehnt
 * `addService` ab.
 *
 * Die eine Stelle für alle vier Routen (Oberfläche und `/api/internal`, je
 * Anlegen und Ändern). Vier Kopien wären vier, von denen eine das Passwort
 * ungeprüft durchließe.
 */
export function readServiceRequest(body: unknown): CreateServiceInput {
  const input = readServiceInput(body);
  const raw = (body ?? {}) as Record<string, unknown>;
  const password = typeof raw.lockPassword === 'string' ? raw.lockPassword : '';
  if (password === '' || input.passwordLock !== KEEP_PASSWORD) return input;

  const invalid = validateLockPassword(password);
  if (invalid) throw new ApiError(invalid);
  return { ...input, passwordLock: createPasswordLock(password) };
}
