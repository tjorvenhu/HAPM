import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError } from '@/lib/api';
import { systemOverview } from '@/lib/system/overview';

/**
 * Die Übersicht der Installation in einer Antwort, wie auf der Startseite und
 * in `get_system_status`: Container, acme.sh, Ziele ohne Backend,
 * Zertifikate, Läufe, Updates. `null` heißt unbekannt, nicht null.
 */
export async function GET(request: Request) {
  try {
    await requireServiceToken(request);
    return ok(await systemOverview());
  } catch (err) {
    return handleError(err);
  }
}
