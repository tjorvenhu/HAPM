import { headers } from 'next/headers';
import { auth } from '@/lib/auth/config';
import { forwardAuthCookies } from '@/lib/auth/passkeys';
import { requireCsrf, requirePartialSession } from '@/lib/session';
import { clear2FACookie } from '@/lib/two-factor';
import { logAudit, getClientIP } from '@/lib/audit';
import { ok, handleError } from '@/lib/api';

/**
 * Abmelden: zwei Nachweise, also zwei Handgriffe. Die Sitzung liegt in
 * `auth_sessions` und wird von `signOut` gelöscht, der Nachweis des zweiten
 * Faktors liegt in einem eigenen Cookie und gälte sonst noch bis zu einem Tag.
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    // Auch wer beim zweiten Faktor abbricht, meldet sich ab.
    const session = await requirePartialSession();

    const signOut = await (await auth()).api.signOut({ headers: await headers(), returnHeaders: true });
    await clear2FACookie();

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'logout',
      ip: getClientIP(request),
    });

    const response = ok();
    // Die Löschanweisungen hängen an der Antwort des Anmeldedienstes. Ohne das
    // Umhängen behielte der Browser den Cookie der beendeten Sitzung.
    forwardAuthCookies(signOut.headers, response);
    return response;
  } catch (err) {
    return handleError(err);
  }
}
