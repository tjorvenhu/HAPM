import { requireSession } from '@/lib/session';
import { ok, handleError } from '@/lib/api';
import { pendingUpdateCount } from '@/lib/updates/check';

/** Die Zähler der Seitenleiste. Liest nur den Stand der letzten Prüfung, fragt keine Registry. */
export async function GET() {
  try {
    await requireSession();
    return ok({ updates: await pendingUpdateCount() });
  } catch (err) {
    return handleError(err);
  }
}
