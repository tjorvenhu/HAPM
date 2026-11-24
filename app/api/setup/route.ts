import { isAPIError } from 'better-auth/api';
import { auth, sessionHeaders } from '@/lib/auth/config';
import { forwardAuthCookies } from '@/lib/auth/passkeys';
import { countUsers, createUser, recordLogin } from '@/lib/auth/users';
import { csrfFor, getSession } from '@/lib/session';
import { readSetupView } from '@/lib/setup';
import { clear2FACookie } from '@/lib/two-factor';
import { updateSettings } from '@/lib/settings';
import { ensureAcme } from '@/lib/acme';
import { validateEmail } from '@/lib/validation';
import { logAudit, getClientIP } from '@/lib/audit';
import { rateLimit } from '@/lib/rate-limit';
import { ok, fail, handleError, jsonBody, ApiError } from '@/lib/api';

/**
 * Die Ersteinrichtung: das erste Konto und die Adresse für Let's Encrypt.
 * Alles danach (Erreichbarkeit, DNS-Anbieter, Adresse der Oberfläche) sind
 * angemeldete Aufrufe unter `/api/setup/*`.
 *
 * Anlegen geht ohne Sitzung, weil es auf einer frischen Installation noch kein
 * Konto gibt, mit dem man sich anmelden könnte. Deshalb ist POST tot, sobald
 * eines existiert.
 *
 * Zwei Sperren, weil die Zählung allein ein Wettlauf ist: zwei gleichzeitige
 * Anfragen sähen beide null Konten. Das erste Konto bekommt deshalb eine feste
 * Kennung, und die zweite Anfrage läuft in den Primärschlüssel.
 */

const ALREADY_DONE = 'Die Ersteinrichtung ist bereits abgeschlossen.';
const BOOTSTRAP_ID = 'bootstrap';

/**
 * Ohne Anmeldung nur, ob es schon ein Konto gibt: das braucht die Anmeldeseite,
 * und mehr geht einen Fremden nicht an. Mit Anmeldung der Stand des Assistenten.
 */
export async function GET() {
  try {
    const needsSetup = (await countUsers()) === 0;
    if (needsSetup) return ok({ needsSetup });

    const session = await getSession();
    if (!session.userId || !session.twoFactorVerified) return ok({ needsSetup });

    return ok({ needsSetup, setup: await readSetupView() });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(request: Request) {
  try {
    const ip = getClientIP(request);
    if (ip !== 'unknown') {
      const rl = rateLimit(`setup:${ip}`, 5, 15 * 60 * 1000);
      if (!rl.success) return fail('Zu viele Versuche. Bitte warten Sie 15 Minuten.', 429);
    }

    const body = await jsonBody<{ name?: unknown; email?: unknown; password?: unknown; acmeEmail?: unknown }>(request);
    const { name, email, password } = body;
    if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
      return fail('Name, E-Mail und Passwort sind erforderlich.');
    }

    // Vor dem Anlegen prüfen: scheiterte die Adresse erst danach, gäbe es das
    // Konto schon und die Einrichtung ließe sich nicht wiederholen.
    const acmeEmail = typeof body.acmeEmail === 'string' ? body.acmeEmail.trim() : '';
    if (acmeEmail && !validateEmail(acmeEmail)) {
      return fail("Die E-Mail-Adresse für Let's Encrypt ist ungültig.");
    }

    if ((await countUsers()) > 0) return fail(ALREADY_DONE, 409);
    const user = await createUser({ id: BOOTSTRAP_ID, name, email, password }).catch((err: unknown) => {
      // Die feste Kennung war schon vergeben: jemand war gleichzeitig schneller.
      if (err instanceof ApiError && err.status === 409) throw new ApiError(ALREADY_DONE, 409);
      throw err;
    });

    // Ab hier ist die Einrichtung offen: die Übersicht erinnert daran, bis sie
    // abgeschlossen oder ausdrücklich übersprungen ist.
    const settings = await updateSettings({ acmeEmail: acmeEmail || user.email, setupStatus: 'open' });

    let acme: { ok: boolean; detail: string };
    try {
      acme = await ensureAcme(settings.acmeEmail);
    } catch (err) {
      acme = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }

    // Gleich anmelden, über denselben Weg wie die Anmeldeseite. Scheitert das,
    // steht das Konto trotzdem: die Antwort schickt dann zur Anmeldung.
    const signIn = await (await auth())
      .api.signInEmail({
        body: { email: user.email, password },
        headers: await sessionHeaders(request),
        returnHeaders: true,
      })
      .catch((err: unknown) => {
        if (isAPIError(err)) return null;
        throw err;
      });
    await clear2FACookie();
    if (signIn) await recordLogin(user.$id);

    await logAudit({
      userId: user.$id,
      userEmail: user.email,
      action: 'setup_completed',
      ip,
      details: acme.ok ? undefined : `acme.sh nicht eingerichtet: ${acme.detail}`,
    });

    const response = ok({ csrfToken: signIn ? csrfFor(signIn.response.token) : null, acme });
    if (signIn) forwardAuthCookies(signIn.headers, response);
    return response;
  } catch (err) {
    return handleError(err);
  }
}
