import { requireSession, requireCsrf } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { getT } from '@/lib/i18n/server';
import { getClientIP } from '@/lib/audit';
import {
  baseConfigOptions,
  getProxyServer,
  probeProxy,
  precheckCreate,
  readPemCoverage,
  readBackendCas,
} from '@/lib/haproxy/provision';
import { diffBaseConfig } from '@/lib/haproxy/base-config-diff';
import { startHaproxyRun } from '@/lib/haproxy/runner';
import { getSettings, challengeFor } from '@/lib/settings';
import { selectedDnsDomains } from '@/lib/dns/zones';
import { readServiceRequest } from '@/lib/haproxy/password-lock';
import {
  validateNewService,
  withoutLockSecret,
  parseGlobalHeaders,
  parseDefaultsTunnel,
  parseCrowdsecGlobal,
  parseGlobalSettings,
  parseScopes,
  serviceHealth,
  HaproxyConfigError,
  type HaproxyService,
  type HaproxyScopeInfo,
  type ServiceHealth,
} from '@/lib/haproxy/config';
import type { HeaderDirection } from '@/lib/haproxy/config';
import type { HaproxyStream } from '@/lib/haproxy/streams';
import { surfaceTarget, type SurfaceTarget } from '@/lib/haproxy/protected';
import { LOCAL_SERVER_ID, localServer } from '@/lib/helpers';
import { crowdsecInstalled } from '@/lib/crowdsec/paths';
import type { CertificateSource, Exposure } from '@/lib/types';

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
  /** `upload`: HAPM beantragt nie selbst, ein Ziel braucht ein vorhandenes Zertifikat. */
  certificateSource: CertificateSource;
  /** Ein eigener ACME-Server erreicht HAPM über Port 80: HTTP-01 auch intern. */
  httpChallenge: boolean;
  /** Die Domains jeder gültigen PEM-Datei. Deckt eine davon ein Ziel ab, wird nichts beantragt. */
  presentCertificates: string[][];
  /** Die Namen der hinterlegten Zertifizierungsstellen, für die Auswahl im Dialog (`backendTls: 'ca:<name>'`). */
  backendCas: string[];
  services: HaproxyService[];
  /**
   * Das Ziel, über das die Adresse von HAPM läuft, und seine Gruppe. Beide
   * lassen sich nicht entfernen (`lib/haproxy/protected.ts`), und die Seite
   * zeigt das, statt einen Knopf anzubieten, der dann scheitert. `null`: es
   * gibt keins, oder die Adresse ist nicht eingerichtet.
   */
  surface: SurfaceTarget | null;
  /** Die Gruppen: die Marker-Paare der Konfiguration. */
  scopes: HaproxyScopeInfo[];
  /** Die Adressen aus `acl admin_ips src …`. Sie stehen hier mit, weil das
   *  Formular sie braucht: ohne mindestens eine lässt sich kein Eintrag sperren,
   *  und der Schalter soll das sagen, statt es beim Speichern zu melden. */
  adminIps: string[];
  /** Die Header, die das Frontend schon für alle Ziele setzt. Das Formular
   *  sagt damit, ob ein Header am Ziel den globalen ersetzt (Anfrage) oder
   *  von ihm überschrieben wird (Antwort), siehe `parseGlobalHeaders`. */
  globalHeaders: Record<HeaderDirection, string[]>;
  /** `timeout tunnel` aus dem `defaults`-Block, siehe `parseDefaultsTunnel`. */
  defaultsTunnel: string | null;
  /** CrowdSec prüft alle Ziele (Block im HTTPS-Frontend). `null`: von Hand geändert. */
  crowdsecGlobal: boolean | null;
  /** Ob der Stack CrowdSec mitbringt. Ohne kann der Schalter nichts bewirken. */
  crowdsecInStack: boolean;
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
  /** Wie viele Zeilen der Grundkonfiguration in der Datei fehlen
   *  (`base-config-diff.ts`). Die Karte von HAProxy verweist dann auf
   *  Reverse-Proxy, Einstellungen. Aus demselben Text gerechnet, ohne Runde. */
  baseConfigMissing: number;
  error: string | null;
}

export async function GET() {
  try {
    await requireSession();
    const { t } = await getT();

    const servers = [localServer()];
    const settings = await getSettings();
    const { exposure, publicUrl } = settings;
    const certificateBase = {
      certificateSource: settings.certificateSource,
      httpChallenge: challengeFor(settings, null).httpReachable,
    };

    // Ein Fehler steht in der Zeile und wirft nicht: HAProxy, das gerade nicht
    // antwortet, ist eine Auskunft.
    const rows: ProxyRow[] = await Promise.all(
      servers.map(async (server) => {
        const base = { $id: server.$id, name: server.name, host: server.host, exposure, ...certificateBase };
        try {
          const probe = await probeProxy(server);
          if (!probe.configReadable) {
            return {
              ...base,
              version: probe.version,
              acmeReady: probe.acmeReady,
              dnsHooks: probe.dnsHooks,
              presentCertificates: [],
              backendCas: [],
              services: [],
              surface: null,
              streams: [],
              scopes: [],
              adminIps: [],
              globalHeaders: { request: [], response: [] },
              defaultsTunnel: null,
              crowdsecGlobal: null,
              crowdsecInStack: crowdsecInstalled(),
              health: {},
              baseConfigMissing: 0,
              error: t('Die HAProxy-Konfiguration ist nicht lesbar.'),
            };
          }
          return {
            ...base,
            version: probe.version,
            acmeReady: probe.acmeReady,
            dnsHooks: probe.dnsHooks,
            presentCertificates: await readPemCoverage(server),
            backendCas: ((await readBackendCas(server)) ?? []).map((ca) => ca.name),
            // Ohne Hash und Cookie-Wert der Passwortsperre: der Cookie-Wert
            // ist der Durchlass selbst und gehört nicht in den Browser.
            services: probe.services.map(withoutLockSecret),
            surface: surfaceTarget(probe.services, { publicUrl }),
            streams: probe.streams,
            scopes: parseScopes(probe.raw),
            adminIps: parseGlobalSettings(probe.raw).adminIps,
            globalHeaders: parseGlobalHeaders(probe.raw),
            defaultsTunnel: parseDefaultsTunnel(probe.raw),
            crowdsecGlobal: parseCrowdsecGlobal(probe.raw),
            crowdsecInStack: crowdsecInstalled(),
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
            baseConfigMissing: diffBaseConfig(probe.raw, baseConfigOptions(probe.raw)).drifts.filter(
              (drift) => drift.kind === 'missing'
            ).length,
            error: null,
          };
        } catch (err) {
          return {
            ...base,
            version: null,
            acmeReady: false,
            dnsHooks: [],
            presentCertificates: [],
            backendCas: [],
            services: [],
            surface: null,
            streams: [],
            scopes: [],
            adminIps: [],
            globalHeaders: { request: [], response: [] },
              defaultsTunnel: null,
            crowdsecGlobal: null,
            crowdsecInStack: crowdsecInstalled(),
            health: {},
            baseConfigMissing: 0,
            error: err instanceof Error ? err.message : t('HAProxy ist nicht erreichbar.'),
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
 * Die Antwort trägt die ID des Laufs und die Dienst-ID. Alles, was Zeit kostet
 * — Zertifikat, Prüfung, Reload — läuft abgekoppelt weiter
 * (lib/haproxy/runner.ts), sichtbar in der Pille unten rechts. Vorher
 * blockierte diese Route bis zum Reload, also bis zu fünf Minuten, und der
 * Dialog stand so lange offen.
 *
 * Die Dienst-ID schickt das Formular nicht mit: sie ergibt sich aus der
 * Hauptdomain und wird in der Vorabprüfung vergeben, wo die Datei vorliegt
 * (`precheckCreate`).
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
    const draft = readServiceRequest(body);
    // Dieselbe Funktion wie im Formular. Ein Dialog, der etwas durchlässt, was
    // die Route danach ablehnt, ist schlimmer als gar keine Vorabprüfung.
    const invalid = validateNewService(draft);
    if (invalid) throw new ApiError(invalid);

    // Nicht Teil der Eingabe: der Hook steht in keiner Zeile der Konfiguration,
    // siehe `RunOptions.dnsHook`.
    const dnsHook = String(body.dnsHook ?? '').trim() || null;
    // Intern oder öffentlich: davon hängt ab, ob HTTP-01 überhaupt geht (`challenge.ts`).
    const settings = await getSettings();
    const challenge = challengeFor(settings, dnsHook);

    let input;
    try {
      // Mit der Adresse von HAPM: in die Gruppe der Oberfläche legt niemand von Hand an.
      input = await precheckCreate(server, draft, challenge, { publicUrl: settings.publicUrl });
    } catch (err) {
      // Ein Namens- oder Domainkonflikt ist eine Auskunft an den Benutzer und
      // kein 500er.
      if (err instanceof HaproxyConfigError) throw new ApiError(err, 409);
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

    return ok({ runId: run.$id, serviceId: input.id });
  } catch (err) {
    return handleError(err);
  }
}
