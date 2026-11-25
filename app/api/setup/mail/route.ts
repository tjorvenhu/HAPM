import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { logAudit, getClientIP } from '@/lib/audit';
import { getSettings, readSmtpInput, updateSettings } from '@/lib/settings';
import { readSetupView } from '@/lib/setup';
import { updateSetupState } from '@/lib/setup/store';

/**
 * Schritt 5 der Einrichtung: das SMTP-Konto. Ohne Konto gibt es nach der
 * Einrichtung keine Passkeys (`lib/auth/passkey-rules.ts`), und das Fenster
 * „Konto absichern" könnte keinen anbieten.
 *
 * Gespeichert wird in den Einstellungen, mit derselben Prüfung wie unter
 * „Benachrichtigungen" (`readSmtpInput`, `updateSettings`): das Passwort
 * verschlüsselt, zurück geht es nie. Das Konto gilt sofort, nicht erst am Ende
 * des Assistenten.
 *
 * `skip: true` beantwortet den Schritt ohne Konto. `advance: false` speichert
 * nur, für die Testmail (`/api/mail/test` verschickt mit dem gespeicherten
 * Konto), und lässt den Schritt offen.
 */
export async function PUT(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody<Record<string, unknown>>(request);

    // Nach der Einrichtung gehört das Konto der Seite „Benachrichtigungen".
    if ((await getSettings()).setupStatus !== 'open') {
      throw new ApiError(msg('Die Einrichtung ist schon abgeschlossen.'), 409);
    }

    if (body.skip === true) {
      await updateSetupState({ mail: 'skipped' });
      await logAudit({
        userId: session.userId,
        userEmail: session.email,
        action: 'setup_updated',
        resource: 'settings',
        details: 'SMTP-Konto übersprungen',
        ip: getClientIP(request),
      });
      return ok({ setup: await readSetupView() });
    }

    const input = readSmtpInput(body);
    // Ohne Server und Absender verschickt HAPM nichts (`isMailConfigured`). Das
    // soll im Assistenten nicht als eingerichtet durchgehen: dafür gibt es „Überspringen".
    if (typeof input.smtpHost !== 'string' || !input.smtpHost.trim()) {
      throw new ApiError(msg('Bitte geben Sie den SMTP-Server ein oder überspringen Sie den Schritt.'));
    }
    if (typeof input.mailFrom !== 'string' || !input.mailFrom.trim()) {
      throw new ApiError(msg('Bitte geben Sie den Absender ein.'));
    }

    const after = await updateSettings(input);
    if (body.advance !== false) await updateSetupState({ mail: 'set' });

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'setup_updated',
      resource: 'settings',
      // Das Passwort steht nie im Protokoll, auch nicht verschlüsselt.
      details: `SMTP-Konto: ${after.smtpHost}:${after.smtpPort}, Absender ${after.mailFrom}${
        input.smtpPass ? ', Passwort neu gesetzt' : ''
      }`,
      ip: getClientIP(request),
    });

    return ok({ setup: await readSetupView() });
  } catch (err) {
    return handleError(err);
  }
}
