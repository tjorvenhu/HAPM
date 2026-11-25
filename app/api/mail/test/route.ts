import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody } from '@/lib/api';
import { getClientIP } from '@/lib/audit';
import { sendTestMailAs } from '@/lib/settings-actions';

/**
 * Eine Testmail über das gespeicherte SMTP-Konto, ohne Angabe an den
 * Angemeldeten. Prüfung, Begrenzung und Protokoll: `sendTestMailAs`.
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody(request);
    return ok(
      await sendTestMailAs(
        body.to,
        { userId: session.userId, userEmail: session.email, ip: getClientIP(request) },
        session.email
      )
    );
  } catch (err) {
    return handleError(err);
  }
}
