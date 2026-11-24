import { requireCsrf, requireSession, revokeOtherSessions, currentSessionToken } from '@/lib/session';
import { get2FAConfig, enable2FA, set2FACookie } from '@/lib/two-factor';
import { verifyTOTPCode, decryptTOTPSecret } from '@/lib/totp';
import { logAudit, getClientIP } from '@/lib/audit';
import { rateLimit } from '@/lib/rate-limit';
import { ok, fail, handleError, jsonBody } from '@/lib/api';

/**
 * Den ersten Code prüfen und den zweiten Faktor einschalten.
 *
 * `decryptTOTPSecret` direkt und nicht `get2FASecret`: das Geheimnis ist
 * Sekunden alt und mit demselben Schlüssel entstanden. Lässt es sich nicht
 * öffnen, ist das kein falscher Code, sondern ein Fehler.
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();

    const rl = rateLimit(`2fa-verify:${session.userId}`, 5, 5 * 60 * 1000);
    if (!rl.success) return fail('Zu viele Versuche. Bitte warten Sie 5 Minuten.', 429);

    const { code } = await jsonBody<{ code?: unknown }>(request);
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      return fail('Bitte geben Sie den 6-stelligen Code ein.');
    }

    const config = await get2FAConfig(session.userId);
    if (config?.enabled) return fail('Der zweite Faktor ist schon eingerichtet.');
    if (!config) return fail('Die Einrichtung wurde noch nicht gestartet.');

    if (!verifyTOTPCode(decryptTOTPSecret(config.secret), code)) {
      return fail('Der Code stimmt nicht. Bitte versuchen Sie es erneut.');
    }

    // Erst der Nachweis für diese Sitzung, dann der Schalter: andersherum wäre
    // die eigene Sitzung für einen Augenblick unbestätigt.
    await set2FACookie(session.userId, await currentSessionToken());
    await enable2FA(config);
    // Die anderen Sitzungen sind nur mit dem Passwort entstanden. Sie müssten
    // den Code ohnehin zeigen, sollen aber gar nicht erst offen bleiben.
    await revokeOtherSessions();

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: '2fa_setup',
      ip: getClientIP(request),
    });

    return ok();
  } catch (err) {
    return handleError(err);
  }
}
