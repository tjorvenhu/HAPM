import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { logAudit, getClientIP } from '@/lib/audit';
import { restoreOverview, stageFromFolder } from '@/lib/backup/restore';

export const dynamic = 'force-dynamic';

/**
 * Ein Archiv aus dem Sicherungsordner bereitlegen und prüfen. Es wird dabei
 * nichts zurückgespielt. Der Name muss wie ein Archiv von HAPM aussehen, der
 * Ordner ist der eingestellte.
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const { name } = await jsonBody<{ name?: unknown }>(request);
    if (typeof name !== 'string' || !name) throw new ApiError(msg('Es fehlt der Name des Archivs.'));

    const ip = getClientIP(request);
    const staged = await stageFromFolder(name, { userId: session.userId, userEmail: session.email, ip });
    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'backup_restore_checked',
      resource: 'backup',
      details: `${staged.name} aus dem Ordner geprüft`,
      ip,
    });
    return ok(await restoreOverview());
  } catch (err) {
    return handleError(err);
  }
}
