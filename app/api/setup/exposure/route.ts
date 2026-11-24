import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { logAudit, getClientIP } from '@/lib/audit';
import { EXPOSURES, updateSettings } from '@/lib/settings';
import { readSetupView } from '@/lib/setup';
import { getSetupState, updateSetupState } from '@/lib/setup/store';
import type { Exposure } from '@/lib/types';

/**
 * Schritt 2 der Einrichtung: intern oder aus dem Internet erreichbar.
 *
 * Die Wahl gilt sofort, nicht erst am Ende des Assistenten: an ihr hängt, wie
 * das nächste Zertifikat ausgestellt wird (`lib/haproxy/challenge.ts`), und ein
 * Ziel, das jemand zwischendurch von Hand anlegt, soll schon danach gehen.
 */
export async function PUT(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody<{ exposure?: unknown }>(request);

    const exposure = body.exposure as Exposure;
    if (!EXPOSURES.includes(exposure)) {
      throw new ApiError(
        msg('Bitte wählen Sie, ob der Server nur im eigenen Netz oder aus dem Internet erreichbar ist.')
      );
    }

    const state = await getSetupState();
    await updateSetupState({
      exposure,
      // „Übersprungen" gibt es bei einer internen Installation nicht: der Schritt kommt dann wieder.
      ...(exposure === 'internal' && state.dns === 'skipped' ? { dns: 'pending' as const } : {}),
      ...(exposure === 'internal' && state.address === 'skipped' ? { address: 'pending' as const } : {}),
    });
    await updateSettings({ exposure });

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'setup_updated',
      resource: 'settings',
      details: `Erreichbarkeit: ${exposure === 'internal' ? 'nur im eigenen Netz' : 'aus dem Internet'}`,
      ip: getClientIP(request),
    });

    return ok({ setup: await readSetupView() });
  } catch (err) {
    return handleError(err);
  }
}
