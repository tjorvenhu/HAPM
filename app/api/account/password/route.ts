import { requireCsrf, requireSession, revokeOtherSessions } from '@/lib/session';
import { changePassword } from '@/lib/auth/users';
import { logAudit, getClientIP } from '@/lib/audit';
import { rateLimit } from '@/lib/rate-limit';
import { ok, fail, handleError, jsonBody } from '@/lib/api';

export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();

    // Eine offene Sitzung soll kein Weg sein, das aktuelle Passwort durchzuprobieren.
    const rl = rateLimit(`password:${session.userId}`, 5, 15 * 60 * 1000);
    if (!rl.success) return fail('Zu viele Versuche. Bitte warten Sie 15 Minuten.', 429);

    const { current, next } = await jsonBody<{ current?: unknown; next?: unknown }>(request);
    if (typeof current !== 'string' || typeof next !== 'string' || !current || !next) {
      return fail('Das aktuelle und das neue Passwort sind erforderlich.');
    }

    await changePassword(session.userId, current, next);
    await revokeOtherSessions();

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'password_changed',
      ip: getClientIP(request),
    });

    return ok();
  } catch (err) {
    return handleError(err);
  }
}
