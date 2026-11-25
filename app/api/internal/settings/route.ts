import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError, jsonBody } from '@/lib/api';
import { getClientIP, serviceActor } from '@/lib/audit';
import { changeSettings, readServiceSettingsInput, settingsOverview } from '@/lib/settings-actions';

/**
 * Die Einstellungen von HAPM: Art der Installation, Herkunft der Zertifikate,
 * E-Mail für Let's Encrypt, SMTP-Konto, Empfänger und Ereignisse der
 * Benachrichtigungen, selbsttätige Updates. Dazu der Stand des Mailversands.
 *
 * Das SMTP-Passwort kommt nie zurück, nur `smtpPassSet`. PATCH ist ein
 * Teil-Patch wie `/api/settings` und lehnt `publicUrl` und `smtpPass` ab
 * (`readServiceSettingsInput`). Woher Zertifikate kommen, steht unter
 * `./certificates`.
 */

export async function GET(request: Request) {
  try {
    await requireServiceToken(request);
    return ok(await settingsOverview());
  } catch (err) {
    return handleError(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const service = await requireServiceToken(request);
    const input = readServiceSettingsInput(await jsonBody(request));
    return ok(await changeSettings(input, { ...serviceActor(service), ip: getClientIP(request) }));
  } catch (err) {
    return handleError(err);
  }
}
