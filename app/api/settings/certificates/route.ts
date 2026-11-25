import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody } from '@/lib/api';
import { getClientIP } from '@/lib/audit';
import { changeCertificateSettings } from '@/lib/settings-actions';

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
    const body = await jsonBody(request);
    return ok(
      await changeCertificateSettings(
        body,
        { userId: session.userId, userEmail: session.email, ip: getClientIP(request) },
        { allowEab: true }
      )
    );
  } catch (err) {
    return handleError(err);
  }
}
