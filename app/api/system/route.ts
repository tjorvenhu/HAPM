import { requireSession } from '@/lib/session';
import { ok, handleError } from '@/lib/api';
import { systemOverview } from '@/lib/system/overview';

/** Alles für die Übersicht in einer Antwort. Die Teile stehen in `lib/system/overview.ts`. */
export async function GET() {
  try {
    await requireSession();
    return ok(await systemOverview());
  } catch (err) {
    return handleError(err);
  }
}
