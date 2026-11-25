import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { logAudit, getClientIP } from '@/lib/audit';
import { readSetupView } from '@/lib/setup';
import { certificatePathOpen, certificateFactsOf, wildcardPossible } from '@/lib/setup/rules';
import { getSetupState, updateSetupState } from '@/lib/setup/store';
import { readCertificateSettings, saveCertificateSettings } from '@/lib/certificate-settings';

/**
 * Schritt 4 der Einrichtung: woher die Zertifikate kommen.
 *
 * Dieselbe Speicherung wie unter „Allgemein" (`saveCertificateSettings`): die
 * Wahl gilt sofort, wie die Erreichbarkeit, und ein eigener ACME-Server wird
 * erst übernommen, wenn acme.sh ein Konto bei ihm hat.
 *
 * Abgelehnt wird eine Wahl, mit der kein Zertifikat entstehen kann
 * (`certificatePathOpen`): intern, ohne DNS-Anbieter, bei Let's Encrypt oder
 * bei einem eigenen Server, der HAPM nicht über Port 80 erreicht. Geprüft wird
 * vor dem Speichern, damit eine abgelehnte Wahl auch die Einstellungen nicht
 * ändert.
 */
export async function PUT(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const input = readCertificateSettings(await jsonBody(request));

    const state = await getSetupState();
    if (!state.exposure) throw new ApiError(msg('Bitte wählen Sie zuerst die Erreichbarkeit.'));

    const facts = certificateFactsOf({
      certificateSource: input.source,
      acmeDirectory: input.acmeDirectory,
      acmeHttpReachable: input.httpReachable,
    });
    if (!certificatePathOpen(state, facts)) {
      throw new ApiError(
        msg(
          "So entsteht kein Zertifikat: Let's Encrypt erreicht eine interne Installation nur über einen DNS-Anbieter. Wählen Sie einen eigenen ACME-Server, der HAPM über Port 80 erreicht, oder laden Sie Zertifikate hoch."
        )
      );
    }

    const result = await saveCertificateSettings(input);
    await updateSetupState({
      certificates: 'set',
      // Eine Wildcard gibt es danach nur noch, wenn sie sich ausstellen lässt.
      ...(state.wildcard && !wildcardPossible(state, facts) ? { wildcard: false, wildcardBase: null } : {}),
    });

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'setup_updated',
      resource: 'settings',
      details: result.audit,
      ip: getClientIP(request),
    });

    return ok({ setup: await readSetupView(), registered: result.registered });
  } catch (err) {
    return handleError(err);
  }
}
