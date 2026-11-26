import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { logAudit, getClientIP } from '@/lib/audit';
import { RESTORE_MAX_BYTES, restoreOverview, stageUpload } from '@/lib/backup/restore';

export const dynamic = 'force-dynamic';

/**
 * Ein Archiv hochladen und prüfen, etwa für den Umzug von einem anderen
 * Server. Die Datei steht roh im Rumpf (wie beim Upload der Länder-Tabelle),
 * ihr Name in `?name=`. Sie geht gestreamt auf die Platte, nie in den
 * Speicher, und über `RESTORE_MAX_BYTES` bricht das Lesen ab.
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();

    const declared = Number(request.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > RESTORE_MAX_BYTES) {
      throw new ApiError(msg('Das Archiv ist größer als {max}. So groß wird eine Sicherung von HAPM nicht.', { max: '512 MB' }), 413);
    }

    const ip = getClientIP(request);
    const name = new URL(request.url).searchParams.get('name');
    const staged = await stageUpload(request.body, name, { userId: session.userId, userEmail: session.email, ip });
    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'backup_restore_checked',
      resource: 'backup',
      details:
        'check' in staged
          ? `${staged.name} hochgeladen und geprüft (${staged.sizeBytes} Bytes)`
          : `${staged.name} hochgeladen (${staged.sizeBytes} Bytes), verschlüsselt: wartet auf den Sicherungsschlüssel`,
      ip,
    });
    return ok(await restoreOverview());
  } catch (err) {
    return handleError(err);
  }
}
