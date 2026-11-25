import { requireSession, requireCsrf } from '@/lib/session';
import { listAll, createDocument } from '@/lib/db';
import { COLLECTIONS, type SavedTargetDoc } from '@/lib/types';
import { logAudit, getClientIP } from '@/lib/audit';
import { ok, handleError } from '@/lib/api';
import { savedTargetAddress } from '@/lib/haproxy/saved-targets';
import { readSavedTarget, toSavedTarget } from '@/lib/haproxy/saved-targets-store';

/**
 * Gespeicherte Ziele: Name, Host und auf Wunsch ein Port. Eine Eingabehilfe für
 * die Dialoge, `haproxy.cfg` erfährt davon nichts (siehe
 * `lib/haproxy/saved-targets.ts`).
 */

export async function GET() {
  try {
    await requireSession();
    const docs = await listAll<SavedTargetDoc>(COLLECTIONS.SAVED_TARGETS);
    const targets = docs.map(toSavedTarget).sort((a, b) => a.name.localeCompare(b.name, 'de'));
    return ok(targets);
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const target = await readSavedTarget(request, null);
    const created = await createDocument<SavedTargetDoc>(COLLECTIONS.SAVED_TARGETS, target);

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'saved_target_created',
      resource: 'saved_target',
      resourceId: created.$id,
      details: `${target.name} (${savedTargetAddress(target)})`,
      ip: getClientIP(request),
    });

    return ok(toSavedTarget(created));
  } catch (err) {
    return handleError(err);
  }
}
