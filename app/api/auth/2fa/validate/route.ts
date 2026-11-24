import { recordLogin } from '@/lib/auth/users';
import { requireCsrf, requirePartialSession, currentSessionToken } from '@/lib/session';
import { has2FAEnabled, get2FASecret, set2FACookie } from '@/lib/two-factor';
import { verifyTOTPCode } from '@/lib/totp';
import { logAudit, getClientIP } from '@/lib/audit';
import { rateLimit } from '@/lib/rate-limit';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';

/**
 * Der zweite Schritt der Anmeldung: der Code aus der Authenticator-App.
 *
 * Der Erfolg stellt den Nachweis für diese Sitzung aus (`lib/two-factor.ts`).
 * Ein Geheimnis, das sich nicht öffnen lässt, ist wie ein falscher Code:
 * abgelehnt, mit derselben Antwort. Der Grund steht im Protokoll.
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requirePartialSession();

    const rl = rateLimit(`2fa:${session.userId}`, 5, 5 * 60 * 1000);
    if (!rl.success) throw new ApiError(msg('Zu viele Versuche. Bitte warten Sie 5 Minuten.'), 429);

    if (session.twoFactorVerified) throw new ApiError(msg('Der zweite Faktor ist in dieser Sitzung schon bestätigt.'));

    const { code } = await jsonBody<{ code?: unknown }>(request);
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      throw new ApiError(msg('Bitte geben Sie den 6-stelligen Code ein.'));
    }

    const ip = getClientIP(request);
    const secret = (await has2FAEnabled(session.userId)) ? await get2FASecret(session.userId) : null;

    if (!secret || !verifyTOTPCode(secret, code)) {
      await logAudit({
        userId: session.userId,
        userEmail: session.email,
        action: '2fa_failed',
        ip,
        details: secret ? 'Ungültiger Code' : 'Geheimnis nicht lesbar',
      });
      throw new ApiError(msg('Der Code stimmt nicht. Bitte versuchen Sie es erneut.'));
    }

    await set2FACookie(session.userId, await currentSessionToken());
    await recordLogin(session.userId);

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: '2fa_verified',
      ip,
    });

    return ok();
  } catch (err) {
    return handleError(err);
  }
}
