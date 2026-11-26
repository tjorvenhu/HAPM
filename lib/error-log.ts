/**
 * Unbekannte Fehler: die Antwort nennt nur eine Kennung, der Text steht hier.
 *
 * Eine Route antwortet auf alles, was sie nicht selbst als Meldung geworfen hat
 * (`ApiError`), mit „Unbekannter Fehler" und einer Kennung. Der eigentliche
 * Text (Treiber der Datenbank, Pfade, Ausgabe eines Kommandos) geht nicht mit:
 * auch die Anmeldung und die Einrichtung antworten ohne Sitzung, und dort hat
 * er nichts zu suchen. Wer angemeldet ist, holt ihn über die Kennung
 * (`GET /api/errors/<kennung>`), die Oberfläche bietet das an jeder solchen
 * Meldung als „Anzeigen" an. Dasselbe steht im Log des Containers.
 *
 * Im Speicher und nicht in der Datenbank: ein Fehler der Datenbank ließe sich
 * dort gerade nicht ablegen. Nach einem Neustart bleibt das Log.
 */

import { randomBytes } from 'node:crypto';
import { ERROR_CODE } from './error-code';

export interface LoggedError {
  code: string;
  at: string;
  message: string;
  /** Die ersten Zeilen des Stapels, wo es einen gibt. */
  stack: string | null;
}

const KEEP = 200;
const store = globalThis as unknown as { __hapmErrorLog?: LoggedError[] };

function entries(): LoggedError[] {
  return (store.__hapmErrorLog ??= []);
}

/** Einen Fehler ablegen und ins Log schreiben. Gibt die Kennung zurück. */
export function rememberError(err: unknown): string {
  const code = `F-${randomBytes(3).toString('hex').toUpperCase()}`;
  const error = err instanceof Error ? err : null;
  const list = entries();
  list.push({
    code,
    at: new Date().toISOString(),
    message: error ? error.message : String(err),
    stack: error?.stack ? error.stack.split('\n').slice(0, 12).join('\n') : null,
  });
  if (list.length > KEEP) list.splice(0, list.length - KEEP);
  console.error(`[api] ${code}`, err);
  return code;
}

export function findError(code: string): LoggedError | null {
  if (!ERROR_CODE.test(code)) return null;
  return entries().find((entry) => entry.code === code) ?? null;
}
