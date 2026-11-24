import { headers } from 'next/headers';
import { requirePasskeys, forwardAuthCookies } from '@/lib/auth/passkeys';
import { getClientIP } from '@/lib/audit';
import { rateLimit } from '@/lib/rate-limit';
import { ok, handleError, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';

/**
 * Schritt 1 der Anmeldung mit Passkey: die Aufgabe für das Gerät.
 *
 * Ohne Sitzung und ohne E-Mail-Adresse. Das Gerät bietet die Passkeys an, die
 * es für diese Adresse kennt, und welches Konto gemeint ist, sagt erst seine
 * Antwort in `/api/auth/passkey/login/verify`.
 *
 * Der Anmeldedienst merkt sich die Aufgabe in `auth_verifications` und gibt dem
 * Browser ein signiertes Cookie dazu mit. Jeder Aufruf schreibt also eine
 * Zeile, ohne dass sich jemand ausgewiesen hat. Deshalb dieselbe Grenze wie bei
 * der Anmeldung mit Passwort, in einem eigenen Topf: ein Abbruch am Gerät soll
 * niemandem die Versuche mit dem Passwort nehmen.
 */
export async function POST(request: Request) {
  try {
    const ip = getClientIP(request);
    if (ip !== 'unknown') {
      const rl = rateLimit(`passkey-options:${ip}`, 5, 15 * 60 * 1000);
      if (!rl.success) throw new ApiError(msg('Zu viele Anmeldeversuche. Bitte warten Sie 15 Minuten.'), 429);
    }

    const passkeys = await requirePasskeys();

    /*
     * Ohne die Cookies der Anfrage. Fände der Dienst darin eine Sitzung, auch
     * eine halbe nach dem Passwortschritt, schränkte er die Aufgabe auf die
     * Passkeys dieses Kontos ein und nennte dabei deren Kennungen. Wer nur ein
     * Passwort kennt, bekäme so eine Auskunft über das Konto.
     */
    const anonymous = new Headers(await headers());
    anonymous.delete('cookie');

    const challenge = await passkeys.generatePasskeyAuthenticationOptions({
      headers: anonymous,
      returnHeaders: true,
    });

    const response = ok({ options: challenge.response });
    forwardAuthCookies(challenge.headers, response);
    return response;
  } catch (err) {
    return handleError(err);
  }
}
