import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { getT } from '@/lib/i18n/server';
import { logAudit, getClientIP } from '@/lib/audit';
import {
  probeProxy,
  readCertificateInventory,
  removeAcmeCertificate,
  removeUploadedCertificate,
  uploadCertificate,
} from '@/lib/haproxy/provision';
import { certificateKeepers, certificateUse, pemFileName, type AcmeCertificate } from '@/lib/haproxy/certs';
import { inspectUpload, isPemFileName, servedFiles, type UploadedCertificate } from '@/lib/haproxy/cert-upload';
import { isValidDomain, scopeSlug, type HaproxyService } from '@/lib/haproxy/config';
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
 * Was acme.sh führt, entsteht und vergeht mit einem Dienst. Gelöscht wird es
 * hier nur, wenn niemand es hält (`certificateKeepers`): kein Ziel bekommt es
 * ausgeliefert, und es deckt keine Domain eines Ziels ab. Sonst hieße es, dem
 * Reverse-Proxy das PEM unter einer laufenden Domain wegzuziehen. Hochgeladene
 * Zertifikate entstehen dagegen nur hier, also werden sie hier auch ersetzt
 * und entfernt (POST, DELETE), und zwar nur, solange kein Ziel ohne sie
 * dastünde.
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
  /** Die Dienste, für deren Domains HAProxy dieses Zertifikat ausliefert. Leer
   *  heißt: es liegt da, ohne dass ein Eintrag es braucht, oder ein genaueres
   *  Zertifikat bedient dieselben Namen. */
  usedBy: CertificateUser[];
  /** Ob die PEM-Datei im Zertifikatsverzeichnis liegt. `false` auch, wenn es
   *  nie ausgestellt wurde (`createdAt: null`); `null` heißt unbekannt. */
  deployed: boolean | null;
  /** Die Dienste, die es halten (`certificateKeepers`): `usedBy` und dazu,
   *  wessen Domain es abdeckt. Leer heißt, es lässt sich löschen. */
  keptBy: string[];
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

/**
 * „Benutzt von" je Datei: welche Dienste das Zertifikat bekommen, das HAProxy
 * per SNI auswählt (`certificateUse`). Nicht jedes, das ihre Domains abdeckt:
 * neben einem eigenen Zertifikat für `app.kunde.example` liefert HAProxy die
 * Wildcard für diesen Namen nicht aus, und sie stünde sonst bei beiden.
 */
function usersByFile(
  files: ReturnType<typeof servedFiles>,
  services: HaproxyService[]
): (file: string) => CertificateUser[] {
  const use = certificateUse(files, services);
  return (file) => {
    const served = files.find((entry) => entry.file === file);
    return (served ? (use.get(served) ?? []) : []).map((service) => ({
      id: service.id,
      slug: service.scope ? scopeSlug(service.scope) : null,
    }));
  };
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
      const acme = probe.acmeReady ? inventory.acme : [];
      const files = servedFiles(acme, inventory.uploaded, inventory.deployed);
      const usersOf = usersByFile(files, probe.services);
      row = {
        ...base,
        acmeReady: probe.acmeReady,
        dnsHooks: probe.dnsHooks,
        certificates: acme.map((cert) => {
          const file = pemFileName(cert.mainDomain);
          const deployed =
            cert.createdAt === null ? false : inventory.deployed === null ? null : inventory.deployed.includes(file);
          // Ein nie ausgestellter Antrag hat keine Datei. Liegt eine unter seinem
          // Namen, ist sie hochgeladen und steht dort mit ihren Diensten.
          return {
            ...cert,
            deployed,
            usedBy: deployed === false ? [] : usersOf(file),
            keptBy: certificateKeepers(cert, files, probe.services).map((service) => service.id),
          };
        }),
        uploaded: inventory.uploaded.map((cert) => ({ ...cert, usedBy: usersOf(cert.file) })),
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

/**
 * Ein Zertifikat entfernen: `?file=` ein hochgeladenes, `?domain=` eins von
 * acme.sh (seine Hauptdomain). Ob es noch gebraucht wird, prüft
 * `provision.ts` im Lock, nicht die Seite.
 */
export async function DELETE(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const params = new URL(request.url).searchParams;
    const server = localServer();

    const domain = params.get('domain');
    if (domain !== null) {
      const mainDomain = domain.trim().toLowerCase();
      if (!isValidDomain(mainDomain)) throw new ApiError(msg('"{domain}" ist keine gültige Domain.', { domain: mainDomain }));
      const removed = await removeAcmeCertificate(server, mainDomain);
      const cert = removed.certificate;

      await logAudit({
        userId: session.userId,
        userEmail: session.email,
        action: 'haproxy_certificate_removed',
        resource: 'server',
        resourceId: server.$id,
        details:
          `acme.sh ${cert.mainDomain}: ${cert.domains.join(', ')}` +
          (cert.createdAt === null ? ', nie ausgestellt' : removed.reloaded ? `, ${pemFileName(cert.mainDomain)} gelöscht` : ', nicht ausgerollt'),
        ip: getClientIP(request),
      });

      return ok({ mainDomain: cert.mainDomain, reloaded: removed.reloaded });
    }

    const file = params.get('file') ?? '';
    if (!isPemFileName(file)) throw new ApiError(msg('Unbekannte Zertifikatsdatei.'));

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
