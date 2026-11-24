import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError } from '@/lib/api';
import { probeProxy, readCertificates } from '@/lib/haproxy/provision';
import { certCovers } from '@/lib/haproxy/certs';
import { proxyServers, resolveProxy } from '@/lib/haproxy/internal';
import type { Server } from '@/lib/types';

/**
 * Was acme.sh führt, samt der Dienste, die es benutzen.
 *
 * **Nur lesend, und das bleibt so.** Ein Zertifikat entsteht und vergeht mit
 * einem Dienst; es hier einzeln löschbar zu machen hieße, dem Reverse-Proxy das
 * PEM unter einer laufenden Domain wegzuziehen — und das fiele nicht heute auf,
 * sondern beim nächsten Start von HAProxy.
 *
 * Eine eigene Route und kein Feld auf `/services`, weil `acme.sh --list` über
 * jedes Domainverzeichnis läuft. Wer die Dienste pollt, soll das nicht bei
 * jedem Takt mitbezahlen.
 */
export async function GET(request: Request) {
  try {
    await requireServiceToken(request);

    const wanted = new URL(request.url).searchParams.get('serverId');
    const servers: Server[] = wanted ? [await resolveProxy(wanted)] : await proxyServers();

    const rows = await Promise.all(
      servers.map(async (server) => {
        const base = { serverId: server.$id, serverName: server.name };
        try {
          const probe = await probeProxy(server);
          // Ohne acme.sh gibt es keine Liste, und die leere hieße sonst „keine
          // Zertifikate" statt „nicht gefragt".
          const certificates = probe.acmeReady ? await readCertificates(server) : [];

          return {
            ...base,
            acmeReady: probe.acmeReady,
            dnsHooks: probe.dnsHooks,
            certificates: certificates.map((cert) => ({
              ...cert,
              // Leer heißt: das Zertifikat ist entweder von Hand ausgestellt
              // oder von einem gelöschten Dienst übrig. Aufgeräumt wird es
              // nicht automatisch.
              usedBy: probe.services
                .filter((service) =>
                  service.domains.some((domain) => cert.domains.some((p) => certCovers(p, domain)))
                )
                .map((service) => service.id),
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

    return ok(rows);
  } catch (err) {
    return handleError(err);
  }
}
