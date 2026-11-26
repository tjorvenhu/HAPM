import { requireSession } from '@/lib/session';
import { ok, handleError, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { findError } from '@/lib/error-log';

/**
 * Die Einzelheiten zu einem unbekannten Fehler, über die Kennung aus der
 * Meldung (`lib/error-log.ts`). Nur mit Sitzung: der Text kann Pfade und
 * Ausgaben von Kommandos enthalten.
 */
export async function GET(_request: Request, context: { params: Promise<{ code: string }> }) {
  try {
    await requireSession();
    const { code } = await context.params;
    const entry = findError(code);
    if (!entry) {
      throw new ApiError(
        msg('Zu dieser Kennung liegt nichts mehr vor. Im Log des Containers steht der Fehler unter derselben Kennung.'),
        404
      );
    }
    return ok(entry);
  } catch (err) {
    return handleError(err);
  }
}
