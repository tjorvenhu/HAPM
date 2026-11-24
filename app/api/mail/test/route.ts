import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { logAudit, getClientIP } from '@/lib/audit';
import { rateLimit } from '@/lib/rate-limit';
import { validateEmail } from '@/lib/validation';
import { mailConfigured } from '@/lib/mail';
import { sendTestMail } from '@/lib/notifications';

const LIMIT = 5;
const WINDOW_MS = 10 * 60 * 1000;

/**
 * Eine Testmail über das gespeicherte SMTP-Konto. Lehnt der Server ab, ist das
 * kein Fehler der Route: die Antwort trägt seine Meldung, damit sie neben dem
 * Formular stehen kann.
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody(request);

    if (body.to !== undefined && body.to !== null && typeof body.to !== 'string') {
      throw new ApiError(msg('Die Adresse für die Testmail muss ein Text sein.'));
    }
    const to = (typeof body.to === 'string' ? body.to.trim() : '') || session.email;
    if (!validateEmail(to)) throw new ApiError(msg('Die Adresse für die Testmail ist ungültig.'));

    if (!(await mailConfigured())) {
      throw new ApiError(msg('Es ist kein SMTP-Konto eingerichtet. Server und Absender zuerst speichern.'));
    }

    // Jede Testmail ist eine echte Mail an eine frei gewählte Adresse.
    const limit = rateLimit(`mail-test:${session.userId}`, LIMIT, WINDOW_MS);
    if (!limit.success) {
      throw new ApiError(
        msg('Zu viele Testmails. Der nächste Versuch geht in {minutes} Minuten.', {
          minutes: Math.ceil((limit.retryAfter ?? 60) / 60),
        }),
        429
      );
    }

    const result = await sendTestMail(to);
    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: result.sent ? 'mail_test_sent' : 'mail_test_failed',
      resource: 'settings',
      details: result.sent ? `Testmail an ${to}` : `Testmail an ${to}: ${result.error ?? ''}`,
      ip: getClientIP(request),
    });

    return ok(result);
  } catch (err) {
    return handleError(err);
  }
}
