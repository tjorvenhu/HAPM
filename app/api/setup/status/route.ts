import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { logAudit, getClientIP } from '@/lib/audit';
import { getSettings, updateSettings } from '@/lib/settings';
import { readSetupView } from '@/lib/setup';
import { setupExecutionAlive } from '@/lib/setup/run';
import { setDnsAccess } from '@/lib/setup/store';

/**
 * Die offene Einrichtung ausdrücklich überspringen (`skipped`).
 *
 * Nur in eine Richtung: abgeschlossen oder übersprungen ist endgültig, eine
 * Einrichtung lässt sich nicht erneut öffnen. Was sie eingerichtet hat, ändert
 * man danach an seiner Stelle (Adresse und Art unter Allgemein, DNS unter DNS).
 * „Abgeschlossen" entsteht nur, wenn das Ausführen durchgelaufen ist oder eine
 * öffentliche Installation ohne Adresse bleibt (`/api/setup/address`).
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody<{ status?: unknown }>(request);

    if (body.status !== 'skipped') {
      throw new ApiError(msg('Die Einrichtung lässt sich nur überspringen.'));
    }
    const settings = await getSettings();
    if (settings.setupStatus !== 'open') {
      throw new ApiError(msg('Die Einrichtung ist schon abgeschlossen.'), 409);
    }
    if (setupExecutionAlive()) throw new ApiError(msg('Die Einrichtung läuft gerade.'), 409);

    await updateSettings({ setupStatus: 'skipped' });
    // Das Token des DNS-Anbieters lag nur für die Einrichtung beim Assistenten.
    await setDnsAccess(null);

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'setup_updated',
      resource: 'settings',
      details: 'Einrichtung übersprungen',
      ip: getClientIP(request),
    });

    return ok({ setup: await readSetupView() });
  } catch (err) {
    return handleError(err);
  }
}
