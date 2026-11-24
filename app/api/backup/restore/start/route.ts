import { requireCsrf, requireSession } from '@/lib/session';
import { verifyPassword } from '@/lib/auth/users';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { logAudit, getClientIP } from '@/lib/audit';
import { rateLimit } from '@/lib/rate-limit';
import { beginRestore, prepareRestore } from '@/lib/backup/restore';

export const dynamic = 'force-dynamic';

/**
 * Das bereitgelegte Archiv zurückspielen.
 *
 * Verlangt das Passwort, wie das Abschalten des zweiten Faktors: das
 * Zurückspielen ersetzt Konten und Schlüssel, eine offene Sitzung allein soll
 * dafür nicht reichen. Und die Kennung des geprüften Archivs, damit genau das
 * zurückkommt, was die Seite gezeigt hat.
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();

    const rl = rateLimit(`restore:${session.userId}`, 5, 15 * 60 * 1000);
    if (!rl.success) throw new ApiError(msg('Zu viele Versuche. Bitte warten Sie 15 Minuten.'), 429);

    const { id, password } = await jsonBody<{ id?: unknown; password?: unknown }>(request);
    if (typeof password !== 'string' || !password) throw new ApiError(msg('Das Passwort ist erforderlich.'));
    if (!(await verifyPassword(session.userId, password))) throw new ApiError(msg('Das Passwort stimmt nicht.'));

    const prepared = await prepareRestore(id);
    const ip = getClientIP(request);
    const actor = { userId: session.userId, userEmail: session.email, ip };
    // Vor dem Start: so steht der Eintrag auch in der Sicherung von unmittelbar vorher.
    await logAudit({
      ...actor,
      action: 'backup_restore_started',
      resource: 'backup',
      details: `${prepared.staged.name} (${prepared.staged.source === 'upload' ? 'hochgeladen' : 'aus dem Ordner'})`,
    });
    const { runId } = beginRestore(prepared, actor);
    return ok({ runId });
  } catch (err) {
    return handleError(err);
  }
}
