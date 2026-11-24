import { requireSession } from '@/lib/session';
import { ok, handleError } from '@/lib/api';
import { notificationStatus } from '@/lib/notifications';

/** Für die Seite „Benachrichtigungen": eingerichtet oder nicht, und wie der letzte Versand ausging. */
export async function GET() {
  try {
    await requireSession();
    return ok(await notificationStatus());
  } catch (err) {
    return handleError(err);
  }
}
