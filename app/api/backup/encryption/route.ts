import { requireCsrf, requireSession } from '@/lib/session';
import { verifyPassword } from '@/lib/auth/users';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { getClientIP } from '@/lib/audit';
import { rateLimit } from '@/lib/rate-limit';
import { changeBackupPassphrase } from '@/lib/backup/actions';

export const dynamic = 'force-dynamic';

/**
 * Den Sicherungsschlüssel setzen, ändern oder entfernen (`passphrase: null`).
 *
 * Verlangt das Passwort des Kontos, wie das Zurückspielen: wer den Schlüssel
 * tauscht, entscheidet, wer die nächsten Sicherungen lesen kann, und wer ihn
 * entfernt, schreibt sie wieder im Klartext. Eine offene Sitzung allein soll
 * dafür nicht reichen.
 *
 * Eine eigene Route und nicht `PATCH /api/backup`: dessen Funktion teilen sich
 * Oberfläche, interne API und MCP, und den Schlüssel setzt nur die Oberfläche.
 * Die Antwort ist die Übersicht der Sicherung, vom Schlüssel steht darin nur
 * `encrypted`.
 */
export async function PUT(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();

    const rl = rateLimit(`backup-encryption:${session.userId}`, 5, 15 * 60 * 1000);
    if (!rl.success) throw new ApiError(msg('Zu viele Versuche. Bitte warten Sie 15 Minuten.'), 429);

    const { passphrase, password } = await jsonBody<{ passphrase?: unknown; password?: unknown }>(request);
    if (typeof password !== 'string' || !password) throw new ApiError(msg('Das Passwort ist erforderlich.'));
    if (!(await verifyPassword(session.userId, password))) throw new ApiError(msg('Das Passwort stimmt nicht.'));
    if (passphrase === undefined) throw new ApiError(msg('Der Sicherungsschlüssel fehlt.'));

    return ok(
      await changeBackupPassphrase(passphrase, { userId: session.userId, userEmail: session.email, ip: getClientIP(request) })
    );
  } catch (err) {
    return handleError(err);
  }
}
