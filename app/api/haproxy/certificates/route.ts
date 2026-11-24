import { requireSession } from '@/lib/session';
import { ok, handleError } from '@/lib/api';
import { probeProxy, readCertificates } from '@/lib/haproxy/provision';
import { certCovers, type AcmeCertificate } from '@/lib/haproxy/certs';
import { scopeSlug } from '@/lib/haproxy/config';
import { localServer } from '@/lib/helpers';

/**
 * Die Zertifikate von HAProxy.
 *
 * Wie bei den Diensten steht keine Collection dahinter: `acme.sh --list` auf der
 * Maschine ist die Wahrheit. Eine Spiegelung wäre genau dann falsch, wenn jemand
 * dort von Hand ein Zertifikat ausgestellt hat — und das sichtbar zu machen ist
 * der halbe Grund für diese Seite.
 *
 * Sie ist eine eigene Route und kein Feld auf `/api/haproxy/services`, weil
 * `acme.sh --list` über jedes Domainverzeichnis läuft: die Übersicht pollt im
 * Minutentakt je Proxy, diese Seite wird aufgerufen, wenn man sie braucht.
 *
 * Nur lesend. Ein Zertifikat entsteht und vergeht mit einem Dienst — es hier
 * einzeln löschbar zu machen hieße, dem Reverse-Proxy das PEM unter einer
 * laufenden Domain wegzuziehen, und das fiele erst beim nächsten Start von
 * HAProxy auf.
 */

/**
 * Ein Dienst, der dieses Zertifikat benutzt — mit dem, was ein Link zu ihm
 * braucht.
 *
 * Der Adressteil steht mit dabei und wird nicht in der Oberfläche aus dem
 * Gruppennamen gerechnet: `scopeSlug` ist die eine Stelle, die aus einem
 * Marker-Namen einen Pfad macht, und eine zweite Ableitung daneben wäre der
 * Link, der genau dann ins Leere zeigt, wenn jemand eine Gruppe ungewöhnlich
 * benennt. `null` heißt: der Eintrag liegt außerhalb aller Marker und hat gar
 * keine Seite.
 */
interface CertificateUser {
  id: string;
  slug: string | null;
}

interface CertificateRow extends AcmeCertificate {
  /** Die Dienste, die dieses Zertifikat benutzen. Leer heißt: es liegt da, ohne
   *  dass ein Eintrag es braucht — der Fall, für den die Seite existiert. */
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
  certificates: CertificateRow[];
  error: string | null;
}

export async function GET() {
  try {
    await requireSession();

    const servers = [localServer()];

    // Einzeln scheitern lassen: ein Proxy, der gerade nicht antwortet, ist eine
    // Auskunft und kein Grund, die übrigen wegzulassen.
    const rows: ProxyCertificates[] = await Promise.all(
      servers.map(async (server) => {
        const base = { $id: server.$id, name: server.name, host: server.host };
        try {
          const probe = await probeProxy(server);
          const certificates = probe.acmeReady ? await readCertificates(server) : [];

          return {
            ...base,
            acmeReady: probe.acmeReady,
            dnsHooks: probe.dnsHooks,
            certificates: certificates.map((cert) => ({
              ...cert,
              usedBy: probe.services
                .filter((service) =>
                  service.domains.some((domain) => cert.domains.some((p) => certCovers(p, domain)))
                )
                .map((service) => ({
                  id: service.id,
                  slug: service.scope ? scopeSlug(service.scope) : null,
                })),
            })),
            error: null,
          };
        } catch (err) {
          return {
            ...base,
            acmeReady: false,
            dnsHooks: [],
            certificates: [],
            error: err instanceof Error ? err.message : 'HAProxy ist nicht erreichbar.',
          };
        }
      })
    );

    rows.sort((a, b) => a.name.localeCompare(b.name, 'de'));
    return ok(rows);
  } catch (err) {
    return handleError(err);
  }
}
