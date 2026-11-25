import { requireCsrf, requireSession } from '@/lib/session';
import { verifyPassword } from '@/lib/auth/users';
import { replaceRecoveryCodes } from '@/lib/two-factor';
import { logAudit, getClientIP } from '@/lib/audit';
import { rateLimit } from '@/lib/rate-limit';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';

/**
 * Neue Wiederherstellungscodes; die alten gelten danach nicht mehr. Die
 * Antwort trägt sie im Klartext, das einzige Mal.
 *
 * Verlangt das Passwort wie das Abschalten (`../route.ts`): eine offene
 * Sitzung allein soll nicht reichen, um sich einen Weg am zweiten Faktor
 * vorbei zu verschaffen.
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();

    const rl = rateLimit(`2fa-recovery:${session.userId}`, 5, 15 * 60 * 1000);
    if (!rl.success) throw new ApiError(msg('Zu viele Versuche. Bitte warten Sie 15 Minuten.'), 429);

    const { password } = await jsonBody<{ password?: unknown }>(request);
    if (typeof password !== 'string' || !password) throw new ApiError(msg('Das Passwort ist erforderlich.'));
    if (!(await verifyPassword(session.userId, password))) throw new ApiError(msg('Das Passwort stimmt nicht.'));

    const recoveryCodes = await replaceRecoveryCodes(session.userId);
    if (!recoveryCodes) throw new ApiError(msg('Der zweite Faktor ist nicht eingerichtet.'));

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: '2fa_recovery_codes_created',
      ip: getClientIP(request),
      details: `${recoveryCodes.length} Wiederherstellungscodes erzeugt, die alten gelten nicht mehr`,
    });

    return ok({ recoveryCodes });
  } catch (err) {
    return handleError(err);
  }
}
