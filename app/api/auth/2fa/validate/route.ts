import { recordLogin } from '@/lib/auth/users';
import { requireCsrf, requirePartialSession, currentSessionToken, type Session } from '@/lib/session';
import { consumeTOTPCode, set2FACookie, consumeRecoveryCode } from '@/lib/two-factor';
import { normaliseRecoveryCode } from '@/lib/recovery-codes';
import { logAudit, getClientIP } from '@/lib/audit';
import { clearFailures, failuresBlocked, rateLimit, recordFailure } from '@/lib/rate-limit';
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
 *
 * Zwei Grenzen. Fünf Versuche in fünf Minuten bremsen. Fünfzehn Fehlversuche
 * am Tag sperren: wer hier steht, kennt das Passwort schon, und sechs Ziffern
 * sind bei 1440 Versuchen am Tag in Monaten geraten. Ein gültiger Code leert
 * den Zähler.
 *
 * Ein Code aus der App gilt einmal (`consumeTOTPCode`): wer ihn mitliest,
 * meldet sich damit nicht in denselben 90 Sekunden noch einmal an.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const FAILURES_PER_DAY = 15;
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requirePartialSession();

    const rl = rateLimit(`2fa:${session.userId}`, 5, 5 * 60 * 1000);
    if (!rl.success) throw new ApiError(msg('Zu viele Versuche. Bitte warten Sie 5 Minuten.'), 429);
    const failureKey = `2fa-failures:${session.userId}`;
    if (failuresBlocked(failureKey, FAILURES_PER_DAY, DAY_MS).blocked) {
      throw new ApiError(msg('Zu viele falsche Codes. Der zweite Faktor ist für dieses Konto bis zu 24 Stunden gesperrt.'), 429);
    }

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
        recordFailure(failureKey);
        await auditFailure(session, ip, 'Ungültiger Wiederherstellungscode');
        throw new ApiError(msg('Der Wiederherstellungscode stimmt nicht oder ist schon benutzt.'));
      }
      remaining = used.remaining;
    } else {
      if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
        throw new ApiError(msg('Bitte geben Sie den 6-stelligen Code ein.'));
      }
      const outcome = await consumeTOTPCode(session.userId, code);
      if (outcome === 'used') {
        // Kein Fehlversuch: der Code war richtig, nur schon gezeigt (Doppelklick, zweites Gerät).
        await auditFailure(session, ip, 'Code schon benutzt');
        throw new ApiError(msg('Dieser Code wurde schon benutzt. Bitte warten Sie auf den nächsten.'));
      }
      if (outcome !== 'ok') {
        recordFailure(failureKey);
        await auditFailure(session, ip, outcome === 'unreadable' ? 'Geheimnis nicht lesbar' : 'Ungültiger Code');
        throw new ApiError(msg('Der Code stimmt nicht. Bitte versuchen Sie es erneut.'));
      }
    }

    clearFailures(failureKey);
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
