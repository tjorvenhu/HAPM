import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { logAudit, getClientIP } from '@/lib/audit';
import { updateSettings } from '@/lib/settings';
import { readSetupView } from '@/lib/setup';
import { setupExecutionAlive } from '@/lib/setup/run';
import { getSetupState, setDnsAccess, updateSetupState } from '@/lib/setup/store';

/**
 * Die Einrichtung ausdrücklich überspringen (`skipped`) oder erneut öffnen
 * (`open`).
 *
 * „Abgeschlossen" lässt sich hier nicht setzen: das entsteht nur, wenn das
 * Ausführen durchgelaufen ist oder eine öffentliche Installation ohne Adresse
 * bleibt (`/api/setup/address`).
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody<{ status?: unknown }>(request);

    if (body.status !== 'skipped' && body.status !== 'open') {
      throw new ApiError(msg('Die Einrichtung lässt sich überspringen oder erneut öffnen.'));
    }
    if (setupExecutionAlive()) throw new ApiError(msg('Die Einrichtung läuft gerade.'), 409);

    if (body.status === 'open') {
      // „Später" bei der Adresse und das letzte Ausführen gehören zum letzten Durchlauf.
      const state = await getSetupState();
      await updateSetupState({
        execution: null,
        ...(state.address === 'skipped' ? { address: 'pending' as const } : {}),
      });
    }
    await updateSettings({ setupStatus: body.status });
    if (body.status !== 'open') await setDnsAccess(null);

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'setup_updated',
      resource: 'settings',
      details: body.status === 'open' ? 'Einrichtung erneut geöffnet' : 'Einrichtung übersprungen',
      ip: getClientIP(request),
    });

    return ok({ setup: await readSetupView() });
  } catch (err) {
    return handleError(err);
  }
}
