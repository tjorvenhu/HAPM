import { requireCsrf, requireVerifiedSession } from '@/lib/session';
import { getUser, securityPromptDismissed, dismissSecurityPrompt } from '@/lib/auth/users';
import { passkeyStatus } from '@/lib/auth/passkeys';
import { getSettings, publicOrigin } from '@/lib/settings';
import { ok, handleError, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';

/**
 * Das Fenster „Konto absichern“: ob es erscheinen soll, und „Nicht jetzt“.
 *
 * Es erscheint erst unter der Adresse von HAPM (`origin`), nicht in der
 * Einrichtung: dort läuft die Oberfläche noch unter IP und Port, ein
 * Passwortmanager speicherte die Anmeldung für die falsche Adresse, und ein
 * Passkey hängt ohnehin an der Domain. Ob die Seite gerade dort offen ist,
 * weiß nur der Browser, deshalb geht die Adresse mit und der Vergleich steht
 * im Fenster.
 */
export async function GET() {
  try {
    const session = await requireVerifiedSession();
    const user = await getUser(session.userId);
    if (!user) throw new ApiError(msg('Dieses Konto gibt es nicht mehr.'), 404);
    const [settings, passkeys, dismissed] = await Promise.all([
      getSettings(),
      passkeyStatus(),
      securityPromptDismissed(session.userId),
    ]);
    return ok({
      origin: publicOrigin(settings),
      totpEnabled: user.totpEnabled,
      passkeyCount: user.passkeyCount,
      passkeysAvailable: passkeys.available,
      passkeysMissing: passkeys.available ? [] : passkeys.missing,
      dismissed,
    });
  } catch (err) {
    return handleError(err);
  }
}

/** „Nicht jetzt“: das Fenster kommt für dieses Konto nicht wieder. Unter „Konto“ geht beides weiter. */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireVerifiedSession();
    await dismissSecurityPrompt(session.userId);
    return ok();
  } catch (err) {
    return handleError(err);
  }
}
