import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { getT } from '@/lib/i18n/server';
import { logAudit, getClientIP } from '@/lib/audit';
import {
  probeProxy,
  readCertificateInventory,
  removeUploadedCertificate,
  uploadCertificate,
} from '@/lib/haproxy/provision';
import { certCovers, type AcmeCertificate } from '@/lib/haproxy/certs';
import { inspectUpload, isPemFileName, type UploadedCertificate } from '@/lib/haproxy/cert-upload';
import { scopeSlug, type HaproxyService } from '@/lib/haproxy/config';
import { localServer } from '@/lib/helpers';
import { getSettings } from '@/lib/settings';
import type { CertificateSource } from '@/lib/types';

/**
 * Die Zertifikate von HAProxy: was acme.sh führt, und was hochgeladen ist.
 *
 * Wie bei den Diensten steht keine Collection dahinter: `acme.sh --list` und
 * das Zertifikatsverzeichnis sind die Wahrheit. Eine Spiegelung wäre genau
 * dann falsch, wenn jemand dort von Hand ein Zertifikat ausgestellt oder
 * abgelegt hat, und das sichtbar zu machen ist der halbe Grund für diese Seite.
 *
 * Sie ist eine eigene Route und kein Feld auf `/api/haproxy/services`, weil
 * `acme.sh --list` über jedes Domainverzeichnis läuft: die Übersicht pollt im
 * Minutentakt je Proxy, diese Seite wird aufgerufen, wenn man sie braucht.
 *
 * Was acme.sh führt, ist hier nur lesend: es entsteht und vergeht mit einem
 * Dienst, und es hier einzeln zu löschen hieße, dem Reverse-Proxy das PEM unter
 * einer laufenden Domain wegzuziehen. Hochgeladene Zertifikate entstehen
 * dagegen nur hier, also werden sie hier auch ersetzt und entfernt (POST,
 * DELETE), und zwar nur, solange kein Ziel ohne sie dastünde.
 */

/**
 * Ein Dienst, der dieses Zertifikat benutzt, mit dem, was ein Link zu ihm
 * braucht. Der Adressteil kommt von `scopeSlug`, der einen Stelle, die aus
 * einem Marker-Namen einen Pfad macht. `null`: der Eintrag liegt außerhalb
 * aller Marker und hat keine Seite.
 */
interface CertificateUser {
  id: string;
  slug: string | null;
}

interface CertificateRow extends AcmeCertificate {
  /** Die Dienste, die dieses Zertifikat benutzen. Leer heißt: es liegt da, ohne
   *  dass ein Eintrag es braucht. */
  usedBy: CertificateUser[];
}

interface UploadedRow extends UploadedCertificate {
  usedBy: CertificateUser[];
}

interface ProxyCertificates {
  $id: string;
  name: string;
  host: string;
  /** Ohne acme.sh gibt es keine Liste, und die leere Liste hieße sonst „keine
   *  Zertifikate" statt „nicht gefragt". */
  acmeReady: boolean;
  dnsHooks: string[];
  /** `upload`: HAPM beantragt nie selbst. */
  source: CertificateSource;
  certificates: CertificateRow[];
  uploaded: UploadedRow[];
  error: string | null;
}

function usersOf(domains: string[], services: HaproxyService[]): CertificateUser[] {
  return services
    .filter((service) => service.domains.some((domain) => domains.some((p) => certCovers(p, domain))))
    .map((service) => ({ id: service.id, slug: service.scope ? scopeSlug(service.scope) : null }));
}

export async function GET() {
  try {
    await requireSession();
    const { t } = await getT();
    const { certificateSource } = await getSettings();
    const server = localServer();
    const base = { $id: server.$id, name: server.name, host: server.host, source: certificateSource };

    // Ein Proxy, der gerade nicht antwortet, ist eine Auskunft und kein Fehler der Seite.
    let row: ProxyCertificates;
    try {
      const probe = await probeProxy(server);
      const inventory = await readCertificateInventory(server);
      row = {
        ...base,
        acmeReady: probe.acmeReady,
        dnsHooks: probe.dnsHooks,
        certificates: (probe.acmeReady ? inventory.acme : []).map((cert) => ({
          ...cert,
          usedBy: usersOf(cert.domains, probe.services),
        })),
        uploaded: inventory.uploaded.map((cert) => ({ ...cert, usedBy: usersOf(cert.domains, probe.services) })),
        error: null,
      };
    } catch (err) {
      row = {
        ...base,
        acmeReady: false,
        dnsHooks: [],
        certificates: [],
        uploaded: [],
        error: err instanceof Error ? err.message : t('HAProxy ist nicht erreichbar.'),
      };
    }
    return ok([row]);
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Ein Zertifikat hochladen oder ein hochgeladenes ersetzen (`replace`: sein
 * Dateiname). Synchron: der Schlüssel geht aus der Anfrage über stdin in die
 * Datei und steht nie in einer Zeile der Datenbank, auch nicht in einem Lauf.
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody<{ certificate?: unknown; privateKey?: unknown; replace?: unknown }>(request);

    const replace = typeof body.replace === 'string' && body.replace ? body.replace : null;
    if (replace && !isPemFileName(replace)) throw new ApiError(msg('Unbekannte Zertifikatsdatei.'));

    const checked = inspectUpload(
      {
        certificate: typeof body.certificate === 'string' ? body.certificate : '',
        privateKey: typeof body.privateKey === 'string' ? body.privateKey : '',
      },
      Date.now()
    );
    if (!checked.ok) throw new ApiError(checked.message);
    const upload = checked.value;

    const server = localServer();
    await uploadCertificate(server, upload, replace);

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'haproxy_certificate_uploaded',
      resource: 'server',
      resourceId: server.$id,
      // Was es abdeckt und bis wann, nie der Inhalt.
      details:
        `${replace ? `${replace} ersetzt durch ` : ''}${upload.file}: ${upload.domains.join(', ')}, ` +
        `gültig bis ${upload.notAfter.slice(0, 10)}, ausgestellt von ${upload.issuer}`,
      ip: getClientIP(request),
    });

    return ok({
      certificate: {
        file: upload.file,
        mainDomain: upload.mainDomain,
        domains: upload.domains,
        notAfter: upload.notAfter,
        issuer: upload.issuer,
      },
    });
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const file = new URL(request.url).searchParams.get('file') ?? '';
    if (!isPemFileName(file)) throw new ApiError(msg('Unbekannte Zertifikatsdatei.'));

    const server = localServer();
    const removed = await removeUploadedCertificate(server, file);

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'haproxy_certificate_removed',
      resource: 'server',
      resourceId: server.$id,
      details: `${file}: ${removed.domains.join(', ') || 'unlesbar'}`,
      ip: getClientIP(request),
    });

    return ok({ file });
  } catch (err) {
    return handleError(err);
  }
}
