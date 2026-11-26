import { requireCsrf, requireSession, revokeOtherSessions } from '@/lib/session';
import { verifyPassword } from '@/lib/auth/users';
import { has2FAEnabled, remove2FA, clear2FACookie } from '@/lib/two-factor';
import { logAudit, getClientIP } from '@/lib/audit';
import { rateLimit } from '@/lib/rate-limit';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';

/** Den zweiten Faktor abschalten. Verlangt das Passwort, damit eine offene Sitzung allein nicht reicht. */
export async function DELETE(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();

    const rl = rateLimit(`2fa-disable:${session.userId}`, 5, 15 * 60 * 1000);
    if (!rl.success) throw new ApiError(msg('Zu viele Versuche. Bitte warten Sie 15 Minuten.'), 429);

    const { password } = await jsonBody<{ password?: unknown }>(request);
    if (typeof password !== 'string' || !password) throw new ApiError(msg('Das Passwort ist erforderlich.'));

    if (!(await verifyPassword(session.userId, password))) throw new ApiError(msg('Das Passwort stimmt nicht.'));
    if (!(await has2FAEnabled(session.userId))) throw new ApiError(msg('Der zweite Faktor ist nicht eingerichtet.'));

    await remove2FA(session.userId);
    await clear2FACookie();
    // Eine Sitzung, die nach dem Passwort noch am Code hing, gälte ohne zweiten
    // Faktor sonst als angemeldet. Wie beim Einrichten: die anderen enden.
    await revokeOtherSessions();

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
