import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError } from '@/lib/api';
import { getT } from '@/lib/i18n/server';
import { listCertificates } from '@/lib/haproxy/api-actions';

/**
 * Was acme.sh führt, samt der Dienste, die es benutzen.
 *
 * **Nur lesend, und das bleibt so.** Ein Zertifikat entsteht und vergeht mit
 * einem Dienst. Eins, das kein Ziel mehr hält, löscht ein Mensch auf der
 * Zertifikatsseite (`removeAcmeCertificate`); eine Pipeline hat dafür keinen
 * Grund, sie legt Ziele an und entfernt sie.
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
