import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError } from '@/lib/api';
import { checkUpdatesNow, updatesOverview } from '@/lib/updates/actions';

export async function GET() {
  try {
    await requireSession();
    return ok(await updatesOverview());
  } catch (err) {
    return handleError(err);
  }
}

/** Jetzt prüfen. Fragt die Registries und GitHub, geholt wird nichts. */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    await requireSession();
    return ok(await checkUpdatesNow());
  } catch (err) {
    return handleError(err);
  }
}
