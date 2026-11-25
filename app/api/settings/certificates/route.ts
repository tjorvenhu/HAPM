import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody } from '@/lib/api';
import { logAudit, getClientIP } from '@/lib/audit';
import { settingsView } from '@/lib/settings';
import { readCertificateSettings, saveCertificateSettings } from '@/lib/certificate-settings';

/**
 * Woher Zertifikate kommen und bei welchem ACME-Server beantragt wird
 * (Seite „Allgemein").
 *
 * Eine eigene Route und kein Feld von `/api/settings`: ein eigener Server wird
 * erst gespeichert, wenn acme.sh ein Konto bei ihm angemeldet hat, und der
 * EAB-Schlüssel dafür geht an acme.sh und nicht in die Einstellungen. Ins
 * Protokoll kommt, was eingestellt ist, nie der Schlüssel.
 */
export async function PUT(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const input = readCertificateSettings(await jsonBody(request));
    const result = await saveCertificateSettings(input);

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'settings_updated',
      resource: 'settings',
      details: result.audit,
      ip: getClientIP(request),
    });

    return ok({ settings: settingsView(result.settings), registered: result.registered });
  } catch (err) {
    return handleError(err);
  }
}
