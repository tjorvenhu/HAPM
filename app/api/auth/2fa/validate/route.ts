import { recordLogin } from '@/lib/auth/users';
import { requireCsrf, requirePartialSession, currentSessionToken, type Session } from '@/lib/session';
import { has2FAEnabled, get2FASecret, set2FACookie, consumeRecoveryCode } from '@/lib/two-factor';
import { normaliseRecoveryCode } from '@/lib/recovery-codes';
import { verifyTOTPCode } from '@/lib/totp';
import { logAudit, getClientIP } from '@/lib/audit';
import { rateLimit } from '@/lib/rate-limit';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';

/**
 * Der zweite Schritt der Anmeldung: der Code aus der Authenticator-App, oder
 * statt seiner ein Wiederherstellungscode (`recoveryCode`).
 *
 * Der Erfolg stellt den Nachweis für diese Sitzung aus (`lib/two-factor.ts`).
 * Ein Geheimnis, das sich nicht öffnen lässt, ist wie ein falscher Code:
 * abgelehnt, mit derselben Antwort. Der Grund steht im Protokoll.
 *
 * Beide Wege zählen gegen dieselbe Grenze: sonst hätte, wer raten will, mit
 * dem zweiten Feld doppelt so viele Versuche.
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requirePartialSession();

    const rl = rateLimit(`2fa:${session.userId}`, 5, 5 * 60 * 1000);
    if (!rl.success) throw new ApiError(msg('Zu viele Versuche. Bitte warten Sie 5 Minuten.'), 429);

    if (session.twoFactorVerified) throw new ApiError(msg('Der zweite Faktor ist in dieser Sitzung schon bestätigt.'));

    const { code, recoveryCode } = await jsonBody<{ code?: unknown; recoveryCode?: unknown }>(request);
    const ip = getClientIP(request);

    let remaining: number | null = null;
    if (recoveryCode !== undefined) {
      if (typeof recoveryCode !== 'string' || !normaliseRecoveryCode(recoveryCode)) {
        throw new ApiError(msg('Ein Wiederherstellungscode hat zehn Buchstaben und Ziffern, zum Beispiel abcde-23456.'));
      }
      const used = await consumeRecoveryCode(session.userId, recoveryCode);
      if (!used) {
        await auditFailure(session, ip, 'Ungültiger Wiederherstellungscode');
        throw new ApiError(msg('Der Wiederherstellungscode stimmt nicht oder ist schon benutzt.'));
      }
      remaining = used.remaining;
    } else {
      if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
        throw new ApiError(msg('Bitte geben Sie den 6-stelligen Code ein.'));
      }
      const secret = (await has2FAEnabled(session.userId)) ? await get2FASecret(session.userId) : null;
      if (!secret || !verifyTOTPCode(secret, code)) {
        await auditFailure(session, ip, secret ? 'Ungültiger Code' : 'Geheimnis nicht lesbar');
        throw new ApiError(msg('Der Code stimmt nicht. Bitte versuchen Sie es erneut.'));
      }
    }

    await set2FACookie(session.userId, await currentSessionToken());
    await recordLogin(session.userId);

    if (remaining !== null) {
      await logAudit({
        userId: session.userId,
        userEmail: session.email,
        action: '2fa_recovery_code_used',
        ip,
        details: `Noch ${remaining} Wiederherstellungscodes`,
      });
    }
    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: '2fa_verified',
      ip,
    });

    return ok(remaining !== null ? { recoveryCodesLeft: remaining } : undefined);
  } catch (err) {
    return handleError(err);
  }
}

async function auditFailure(session: Session, ip: string, details: string): Promise<void> {
  await logAudit({ userId: session.userId, userEmail: session.email, action: '2fa_failed', ip, details });
}
