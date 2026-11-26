import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { logAudit, getClientIP } from '@/lib/audit';
import { rateLimit } from '@/lib/rate-limit';
import { restoreOverview, unlockStaged } from '@/lib/backup/restore';

export const dynamic = 'force-dynamic';

/**
 * Ein bereitgelegtes, verschlüsseltes Archiv mit einem eingegebenen
 * Sicherungsschlüssel entschlüsseln und prüfen. Gebraucht, wenn keiner
 * gespeichert ist oder der gespeicherte nicht passt (ein Archiv von einem
 * anderen Server). Zurückgespielt wird dabei nichts.
 *
 * Begrenzt je Konto: jeder Versuch lässt gpg den Schlüssel ableiten, und die
 * Route soll kein Werkzeug zum Durchprobieren sein.
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();

    const rl = rateLimit(`restore-unlock:${session.userId}`, 10, 15 * 60 * 1000);
    if (!rl.success) throw new ApiError(msg('Zu viele Versuche. Bitte warten Sie 15 Minuten.'), 429);

    const { id, passphrase } = await jsonBody<{ id?: unknown; passphrase?: unknown }>(request);
    const ip = getClientIP(request);
    const staged = await unlockStaged(id, passphrase, { userId: session.userId, userEmail: session.email, ip });
    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'backup_restore_checked',
      resource: 'backup',
      details: `${staged.name} mit eingegebenem Sicherungsschlüssel entschlüsselt und geprüft`,
      ip,
    });
    return ok(await restoreOverview());
  } catch (err) {
    return handleError(err);
  }
}
