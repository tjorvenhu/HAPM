import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError } from '@/lib/api';
import { getT } from '@/lib/i18n/server';
import { getClientIP, serviceActor } from '@/lib/audit';
import { listCertificates } from '@/lib/haproxy/api-actions';
import { removeCertificate } from '@/lib/haproxy/certificate-actions';

/**
 * Was acme.sh führt, samt der Dienste, die es benutzen.
 *
 * Ein Zertifikat entsteht und vergeht mit einem Dienst. Was danach übrig ist
 * (von einem gelöschten Ziel, von Hand ausgestellt, ein gescheiterter
 * Antrag), entfernt DELETE, aber nur, wenn kein Ziel es hält: das prüft
 * `removeAcmeCertificate` im Lock, wie auf der Zertifikatsseite.
 *
 * Eine eigene Route und kein Feld auf `/services`, weil `acme.sh --list` über
 * jedes Domainverzeichnis läuft. Wer die Dienste pollt, soll das nicht bei
 * jedem Takt mitbezahlen. Die Logik steht in `lib/haproxy/api-actions.ts`.
 */
export async function GET(request: Request) {
  try {
    await requireServiceToken(request);
    const { t } = await getT();
    return ok(await listCertificates(new URL(request.url).searchParams.get('serverId'), t));
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Ein Zertifikat von acme.sh entfernen: `?domain=` seine Hauptdomain.
 * Hochgeladene bleiben der Oberfläche vorbehalten (`removeCertificate`).
 * Synchron: acme.sh vergisst den Eintrag, eine ausgerollte PEM-Datei geht, und
 * HAProxy lädt dann neu (`reloaded`).
 */
export async function DELETE(request: Request) {
  try {
    const service = await requireServiceToken(request);
    const domain = new URL(request.url).searchParams.get('domain') ?? '';
    return ok(
      await removeCertificate({ domain }, { ...serviceActor(service), ip: getClientIP(request) }, { allowUploaded: false })
    );
  } catch (err) {
    return handleError(err);
  }
}
