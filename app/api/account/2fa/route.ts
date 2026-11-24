import { requireCsrf, requireSession } from '@/lib/session';
import { verifyPassword } from '@/lib/auth/users';
import { has2FAEnabled, remove2FA, clear2FACookie } from '@/lib/two-factor';
import { logAudit, getClientIP } from '@/lib/audit';
import { rateLimit } from '@/lib/rate-limit';
import { ok, fail, handleError, jsonBody } from '@/lib/api';

/** Den zweiten Faktor abschalten. Verlangt das Passwort, damit eine offene Sitzung allein nicht reicht. */
export async function DELETE(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();

    const rl = rateLimit(`2fa-disable:${session.userId}`, 5, 15 * 60 * 1000);
    if (!rl.success) return fail('Zu viele Versuche. Bitte warten Sie 15 Minuten.', 429);

    const { password } = await jsonBody<{ password?: unknown }>(request);
    if (typeof password !== 'string' || !password) return fail('Das Passwort ist erforderlich.');

    if (!(await verifyPassword(session.userId, password))) return fail('Das Passwort stimmt nicht.');
    if (!(await has2FAEnabled(session.userId))) return fail('Der zweite Faktor ist nicht eingerichtet.');

    await remove2FA(session.userId);
    await clear2FACookie();

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: '2fa_disabled',
      ip: getClientIP(request),
    });

    return ok();
  } catch (err) {
    return handleError(err);
  }
}
