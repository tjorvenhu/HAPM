import { requireSession, requireCsrf } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { getClientIP } from '@/lib/audit';
import { getProxyServer, probeProxy, precheckCreate } from '@/lib/haproxy/provision';
import { startHaproxyRun } from '@/lib/haproxy/runner';
import { getSettings } from '@/lib/settings';
import { selectedDnsDomains } from '@/lib/dns/zones';
import { readServiceRequest } from '@/lib/haproxy/password-lock';
import {
  validateCreateInput,
  withoutLockSecret,
  parseGlobalSettings,
  parseScopes,
  serviceHealth,
  HaproxyConfigError,
  type HaproxyService,
  type HaproxyScopeInfo,
  type ServiceHealth,
} from '@/lib/haproxy/config';
import type { HaproxyStream } from '@/lib/haproxy/streams';
import { LOCAL_SERVER_ID, localServer } from '@/lib/helpers';
import type { Exposure } from '@/lib/types';

/**
 * Die Reverse-Proxy-Ziele.
 *
 * Es gibt keine Collection dahinter, und das ist die Entscheidung, an der alles
 * hängt: die Wahrheit ist `/etc/haproxy/haproxy.cfg`. Eine Spiegelung in der
 * Datenbank wäre eine zweite Quelle, die genau dann falsch ist, wenn jemand die
 * Datei von Hand angefasst hat — also in dem Moment, in dem man sie am
 * dringendsten braucht. Der Preis ist eine Runde Kommandos je Aufruf.
 *
 * Die Antwort ist eine Liste mit genau einem Eintrag: Seiten, Historie und
 * Metriken führen den Server unter seiner `serverId` (`LOCAL_SERVER_ID`).
 */

interface ProxyRow {
  $id: string;
  name: string;
  host: string;
  version: string | null;
  acmeReady: boolean;
  /** Die eingerichteten acme.sh-DNS-Hooks. Das Formular braucht sie, sobald eine
   *  Wildcard im Spiel ist: HTTP-01 stellt sie nicht aus, und welcher Hook die
   *  Zone bedient, steht nur in acme.sh. Leer heißt: keine Wildcard möglich,
   *  und der Dialog sagt das, statt es beim Speichern zu melden. */
  dnsHooks: string[];
  /** Intern oder öffentlich. Bei `internal` geht jedes Zertifikat über DNS-01,
   *  und das Formular zeigt die Auswahl des Hooks auch ohne Wildcard. */
  exposure: Exposure;
  services: HaproxyService[];
  /** Die Gruppen: die Marker-Paare der Konfiguration. */
  scopes: HaproxyScopeInfo[];
  /** Die Adressen aus `acl admin_ips src …`. Sie stehen hier mit, weil das
   *  Formular sie braucht: ohne mindestens eine lässt sich kein Eintrag sperren,
   *  und der Schalter soll das sagen, statt es beim Speichern zu melden. */
  adminIps: string[];
  /**
   * Die TCP-Weiterleitungen derselben Datei.
   *
   * Hier und nicht in einer eigenen GET-Route: es ist dieselbe `haproxy.cfg`
   * und dieselbe Runde Kommandos. Eine zweite Route hieße, die Gruppenseite müsste
   * zweimal fragen, um eine Liste zu zeigen — und ihre beiden Hälften wären ab
   * dann verschieden alt. Geschrieben wird getrennt (`/api/haproxy/streams`),
   * weil sich dort die Vorgänge unterscheiden.
   */
  streams: HaproxyStream[];
  /** Was HAProxy über die Ziele weiß, je Dienst-ID. Fehlt ein Eintrag, ist
   *  nichts bekannt — kein Stats-Socket, kein socat oder kein Healthcheck.
   *  Die TCP-Weiterleitungen stehen mit drin: ein `listen`-Abschnitt taucht in
   *  `show stat` unter seinem Namen auf wie jedes Backend. */
  health: Record<string, ServiceHealth>;
  error: string | null;
}

export async function GET() {
  try {
    await requireSession();

    const servers = [localServer()];
    const { exposure } = await getSettings();

    // Ein Fehler steht in der Zeile und wirft nicht: HAProxy, das gerade nicht
    // antwortet, ist eine Auskunft.
    const rows: ProxyRow[] = await Promise.all(
      servers.map(async (server) => {
        const base = { $id: server.$id, name: server.name, host: server.host, exposure };
        try {
          const probe = await probeProxy(server);
          if (!probe.configReadable) {
            return {
              ...base,
              version: probe.version,
              acmeReady: probe.acmeReady,
              dnsHooks: probe.dnsHooks,
              services: [],
              streams: [],
              scopes: [],
              adminIps: [],
              health: {},
              error: 'Die HAProxy-Konfiguration ist nicht lesbar.',
            };
          }
          return {
            ...base,
            version: probe.version,
            acmeReady: probe.acmeReady,
            dnsHooks: probe.dnsHooks,
            // Ohne Hash und Cookie-Wert der Passwortsperre: der Cookie-Wert
            // ist der Durchlass selbst und gehört nicht in den Browser.
            services: probe.services.map(withoutLockSecret),
            streams: probe.streams,
            scopes: parseScopes(probe.raw),
            adminIps: parseGlobalSettings(probe.raw).adminIps,
            health: Object.fromEntries([
              ...probe.services.map((service) => [
                service.id,
                serviceHealth(service, probe.serverStates),
              ]),
              // Dieselbe Rechnung: ein `listen`-Abschnitt hat keine Pfad-Regeln,
              // sonst ist er für `show stat` ein Proxy wie jeder andere.
              ...probe.streams.map((stream) => [
                stream.id,
                serviceHealth({ id: stream.id, routes: [] }, probe.serverStates),
              ]),
            ]),
            error: null,
          };
        } catch (err) {
          return {
            ...base,
            version: null,
            acmeReady: false,
            dnsHooks: [],
            services: [],
            streams: [],
            scopes: [],
            adminIps: [],
            health: {},
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

/**
 * Ein Ziel anlegen.
 *
 * Die Antwort trägt nur die ID des Laufs. Alles, was Zeit kostet — Zertifikat,
 * Prüfung, Reload — läuft abgekoppelt weiter (lib/haproxy/runner.ts), sichtbar
 * in der Pille unten rechts. Vorher blockierte diese Route bis zum Reload, also
 * bis zu fünf Minuten, und der Dialog stand so lange offen.
 *
 * Was sich ohne Schreibvorgang beantworten lässt, bleibt trotzdem synchron: ein
 * belegter Name oder eine fremde Domain gehört ins Formular zurück und nicht in
 * die Historie.
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody<{
      serverId?: string;
      dnsHook?: string;
      dnsDomains?: string[];
    }>(request);

    const server = await getProxyServer(body.serverId || LOCAL_SERVER_ID);

    // Mit dem Passwort der Sperre, falls eins mitkam (lib/haproxy/password-lock.ts).
    const input = readServiceRequest(body);
    // Dieselbe Funktion wie im Formular. Ein Dialog, der etwas durchlässt, was
    // die Route danach ablehnt, ist schlimmer als gar keine Vorabprüfung.
    const invalid = validateCreateInput(input);
    if (invalid) throw new ApiError(invalid);

    // Nicht Teil der Eingabe: der Hook steht in keiner Zeile der Konfiguration,
    // siehe `RunOptions.dnsHook`.
    const dnsHook = String(body.dnsHook ?? '').trim() || null;
    // Intern oder öffentlich: davon hängt ab, ob HTTP-01 überhaupt geht (`challenge.ts`).
    const challenge = { exposure: (await getSettings()).exposure, dnsHook };

    try {
      await precheckCreate(server, input, challenge);
    } catch (err) {
      // Ein Namens- oder Domainkonflikt ist eine Auskunft an den Benutzer und
      // kein 500er.
      if (err instanceof HaproxyConfigError) throw new ApiError(err.message, 409);
      throw err;
    }

    const run = await startHaproxyRun({
      server,
      action: 'create',
      serviceId: input.id,
      input,
      challenge,
      dns: { ensure: selectedDnsDomains(body.dnsDomains, input.domains) },
      actor: { userId: session.userId, email: session.email, ip: getClientIP(request) },
    });

    return ok({ runId: run.$id });
  } catch (err) {
    return handleError(err);
  }
}
