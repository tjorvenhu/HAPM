import { requireCsrf, requireSession } from '@/lib/session';
import { has2FAEnabled, store2FASecret } from '@/lib/two-factor';
import { generateTOTPSecret, generateQRCodeDataURL } from '@/lib/totp';
import { rateLimit } from '@/lib/rate-limit';
import { ok, fail, handleError } from '@/lib/api';

/**
 * Ein neues Geheimnis erzeugen. Es liegt danach am Konto, gilt aber erst, wenn
 * `/api/account/2fa/verify` den ersten Code gesehen hat: bis dahin bleibt
 * `enabled` aus, und die Anmeldung fragt nicht danach.
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();

    const rl = rateLimit(`2fa-setup:${session.userId}`, 5, 15 * 60 * 1000);
    if (!rl.success) return fail('Zu viele Versuche. Bitte warten Sie 15 Minuten.', 429);

    if (await has2FAEnabled(session.userId)) return fail('Der zweite Faktor ist schon eingerichtet.');

    const { secret, uri, manualCode } = generateTOTPSecret(session.email);
    const qrCodeDataUrl = await generateQRCodeDataURL(uri);

    await store2FASecret(session.userId, secret);

    return ok({ qrCodeDataUrl, manualCode });
  } catch (err) {
    return handleError(err);
  }
}
