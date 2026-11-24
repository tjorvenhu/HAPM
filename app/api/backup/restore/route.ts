import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError } from '@/lib/api';
import { logAudit, getClientIP } from '@/lib/audit';
import { discardStaged, restoreOverview } from '@/lib/backup/restore';

/**
 * Das Zurückspielen einer Sicherung: Stand und Verwerfen. Bereitlegen liegt
 * unter `./check` (aus dem Ordner) und `./upload`, der Start unter `./start`.
 * Der Ablauf steht in `lib/backup/restore.ts`.
 */

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireSession();
    return ok(await restoreOverview());
  } catch (err) {
    return handleError(err);
  }
}

/** Das bereitgelegte Archiv verwerfen. */
export async function DELETE(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    if (discardStaged()) {
      await logAudit({
        userId: session.userId,
        userEmail: session.email,
        action: 'backup_restore_discarded',
        resource: 'backup',
        ip: getClientIP(request),
      });
    }
    return ok(await restoreOverview());
  } catch (err) {
    return handleError(err);
  }
}
