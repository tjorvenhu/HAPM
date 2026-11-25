import { requireSession, requireCsrf } from '@/lib/session';
import { getDocument, updateDocument, deleteDocument } from '@/lib/db';
import { COLLECTIONS, type SavedTargetDoc } from '@/lib/types';
import { logAudit, getClientIP } from '@/lib/audit';
import { ok, handleError } from '@/lib/api';
import { savedTargetAddress } from '@/lib/haproxy/saved-targets';
import { readSavedTarget, toSavedTarget } from '@/lib/haproxy/saved-targets-store';

/**
 * Ein gespeichertes Ziel ändern oder löschen. Beides fasst keinen Eintrag in
 * `haproxy.cfg` an: dort steht die Adresse, die beim Anlegen eingesetzt wurde.
 */

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const { id } = await params;
    const before = await getDocument<SavedTargetDoc>(COLLECTIONS.SAVED_TARGETS, id);
    const target = await readSavedTarget(request, id);
    const updated = await updateDocument<SavedTargetDoc>(COLLECTIONS.SAVED_TARGETS, id, target);

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'saved_target_changed',
      resource: 'saved_target',
      resourceId: id,
      details: `${before.name} (${savedTargetAddress(before)}) → ${target.name} (${savedTargetAddress(target)})`,
      ip: getClientIP(request),
    });

    return ok(toSavedTarget(updated));
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const { id } = await params;
    const target = await getDocument<SavedTargetDoc>(COLLECTIONS.SAVED_TARGETS, id);
    await deleteDocument(COLLECTIONS.SAVED_TARGETS, id);

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'saved_target_deleted',
      resource: 'saved_target',
      resourceId: id,
      details: `${target.name} (${savedTargetAddress(target)})`,
      ip: getClientIP(request),
    });

    return ok();
  } catch (err) {
    return handleError(err);
  }
}
