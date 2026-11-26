import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError } from '@/lib/api';
import { getClientIP } from '@/lib/audit';
import { createPairingKey } from '@/lib/sync/actions';

export const dynamic = 'force-dynamic';

/**
 * Einen neuen Kopplungsschlüssel erzeugen (nur Folgeknoten). Die Antwort trägt
 * den Klartext, genau einmal: gespeichert wird er verschlüsselt, und keine
 * andere Route gibt ihn je wieder aus.
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    return ok(await createPairingKey({ userId: session.userId, userEmail: session.email, ip: getClientIP(request) }));
  } catch (err) {
    return handleError(err);
  }
}
