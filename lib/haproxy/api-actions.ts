/**
 * Was die Reverse-Proxy-API kann, als Funktionen: der eine Weg, den die Routen
 * unter `/api/internal/haproxy/**` und der MCP-Server (`lib/mcp/`) gehen.
 *
 * ── Warum hier und nicht in den Routen ──
 *
 * Bis zum MCP-Server stand die Logik in den Routendateien. Ein zweiter
 * Aufrufer hätte sie kopieren müssen, und die Kopie wäre die Stelle gewesen,
 * an der eine Schutzregel fehlt (Ziel der Oberfläche, Vorabprüfung, Abgleich
 * der DNS-Domains), die man an der Route später ergänzt. Jetzt prüft eine
 * Route das Token, liest Rumpf und Adresse und ruft hier eine Funktion; das
 * MCP-Werkzeug tut dasselbe mit seinen Argumenten.
 *
 * ── Was die Aufrufer mitgeben ──
 *
 *   - `actor`: wer schreibt. Gebaut wird er beim Aufrufer mit
 *     `haproxyActor(serviceActor(service), request)`, damit in jeder Datei, die
 *     schreibt, sichtbar steht, dass der Name des Tokens in Lauf und Audit geht.
 *   - `t`: die Sprache der Texte, die als Text in einer Antwort stehen
 *     (`unreachable`, `reason`, `error` eines Laufs). Die Route nimmt die der
 *     Anfrage (`getT()`), der MCP-Server seine eigene (`lib/mcp/locale.ts`).
 *
 * Geworfen wird `ApiError` mit dem Status, den die Route schon immer hatte.
 * `handleError` macht daraus die Antwort, der MCP-Server ein Werkzeug-Ergebnis
 * mit `isError`.
 */

import { ApiError } from '../api';
import { msg, type Translatable, type Params } from '../i18n/translate';
import { getDocument, listDocuments, Query } from '../db';
import { COLLECTIONS, type HaproxyAction, type HaproxyRun, type RunStatus, type Server } from '../types';
import { getSettings } from '../settings';
import {
  checkStreamPort,
  precheckCreate,
  precheckDelete,
  precheckScope,
  precheckSettings,
  precheckStreamCreate,
  precheckStreamDelete,
  precheckStreamUpdate,
  precheckUpdate,
  probeProxy,
  readCertificates,
  readGlobalSettings,
} from './provision';
import { parseSteps, startHaproxyRun, stepsAsLog, type HaproxyActor } from './runner';
import {
  HaproxyConfigError,
  readGlobalSettingsPatch,
  serviceHealth,
  settingsEditable,
  validateCreateInput,
  validateGlobalSettings,
  validateNewService,
  validateScopeName,
} from './config';
import { readServiceRequest } from './password-lock';
import { readStreamInput, validateNewStream, validateStreamInput } from './streams';
import { surfaceTarget } from './protected';
import { certCovers } from './certs';
import {
  proxyServers,
  proxyView,
  readDnsDomains,
  resolveProxy,
  serviceView,
  servicesOf,
  streamView,
  streamsOf,
  type ProxyView,
  type ServiceView,
  type StreamView,
} from './internal';

/** Übersetzen in der Sprache des Aufrufers. */
export type Translate = (text: Translatable, params?: Params) => string;

export interface Unreachable {
  serverId: string;
  serverName: string;
  error: string;
}

/** Ein `HaproxyConfigError` aus der Vorabprüfung ist ein Konflikt, kein 500er. */
async function asConflict<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof HaproxyConfigError) throw new ApiError(err, 409);
    throw err;
  }
}

/** Die Maschinen eines Lesezugriffs: eine genannte geht durch `resolveProxy`,
 *  damit eine unbekannte ID ein 404 ist und keine leere Liste. */
async function readServers(serverId: string | null | undefined): Promise<Server[]> {
  return serverId ? [await resolveProxy(serverId)] : proxyServers();
}

/* ── Proxy und Gruppen ── */

export async function listProxies(t: Translate): Promise<ProxyView[]> {
  const rows = await Promise.all((await proxyServers()).map(proxyView));
  return rows.map((row) => ({ ...row, error: row.error === null ? null : t(row.error) }));
}

export async function listScopes(t: Translate) {
  return (await listProxies(t)).map((row) => ({
    serverId: row.id,
    serverName: row.name,
    scopes: row.scopes,
    error: row.error,
  }));
}

export interface ScopeChangeResult {
  name: string;
  runs: { runId: string; serverId: string; serverName: string }[];
}

/**
 * Gruppe anlegen oder entfernen. Vorabgeprüft wird, BEVOR der Lauf startet,
 * sonst endete ein Tippfehler als Zeile in der Historie statt als Antwort.
 * Die Gruppe mit dem Ziel der Oberfläche bleibt stehen (`protected.ts`).
 */
export async function changeScope(
  rawName: unknown,
  action: 'scope-add' | 'scope-remove',
  actor: HaproxyActor
): Promise<ScopeChangeResult> {
  const name = String(rawName ?? '').trim();
  if (action === 'scope-add') {
    // Dieselbe Funktion wie im Formular, damit nicht zwei Regelwerke entstehen.
    const invalid = validateScopeName(name);
    if (invalid) throw new ApiError(invalid);
  } else if (!name) {
    throw new ApiError(msg('Es wurde keine Gruppe angegeben.'));
  }

  const servers = await proxyServers();
  const protection = { publicUrl: (await getSettings()).publicUrl };

  for (const server of servers) {
    await asConflict(() =>
      action === 'scope-add'
        ? precheckScope(server, name, 'add')
        : precheckScope(server, name, 'remove', protection)
    );
  }

  const runs = [];
  for (const server of servers) {
    const started = await startHaproxyRun({ server, action, serviceId: name, protection, actor });
    runs.push({ runId: started.$id, serverId: server.$id, serverName: server.name });
  }
  return { name, runs };
}

/* ── Ziele (Dienste) ── */

export interface ServiceList {
  services: ServiceView[];
  /** Eigenes Feld und keine Ausnahme: eine leere Liste hieße sonst „es gibt
   *  keine Einträge" statt „nicht lesbar", und darauf würde ein Aufrufer etwas
   *  anlegen, das es längst gibt. */
  unreachable: Unreachable[];
}

export async function listServices(
  filter: { serverId?: string | null; scope?: string | null; domain?: string | null },
  t: Translate
): Promise<ServiceList> {
  const servers = await readServers(filter.serverId);
  const domain = filter.domain?.trim().toLowerCase() || null;
  const scope = filter.scope?.trim().toUpperCase() || null;

  const response: ServiceList = { services: [], unreachable: [] };
  // Für `surface` am Eintrag: über welches Ziel die Adresse von HAPM läuft.
  const protection = { publicUrl: (await getSettings()).publicUrl };

  await Promise.all(
    servers.map(async (server) => {
      try {
        const probe = await probeProxy(server);
        if (!probe.configReadable) {
          response.unreachable.push({
            serverId: server.$id,
            serverName: server.name,
            error: t('Die HAProxy-Konfiguration ist nicht lesbar.'),
          });
          return;
        }
        response.services.push(...servicesOf(server, probe, protection));
      } catch (err) {
        response.unreachable.push({
          serverId: server.$id,
          serverName: server.name,
          error: err instanceof Error ? err.message : t('HAProxy ist nicht erreichbar.'),
        });
      }
    })
  );

  response.services = response.services.filter((service) => {
    if (scope && (service.scope ?? '').toUpperCase() !== scope) return false;
    // Exakter Vergleich und keine Teilzeichenkette: `kunde.example` bedient nicht
    // `fremdekunde.example`, obwohl der Name darin vorkommt.
    if (domain && !service.domains.some((d) => d.toLowerCase() === domain)) return false;
    return true;
  });

  response.services.sort(
    (a, b) => a.serverName.localeCompare(b.serverName, 'de') || a.id.localeCompare(b.id, 'de')
  );
  return response;
}

async function readableProbeOf(server: Server) {
  const probe = await probeProxy(server);
  if (!probe.configReadable) {
    throw new ApiError(
      msg('Die HAProxy-Konfiguration auf "{server}" ist nicht lesbar.', { server: server.name }),
      502
    );
  }
  return probe;
}

export async function getService(id: string, serverId?: string | null): Promise<ServiceView> {
  const server = await resolveProxy(serverId);
  const probe = await readableProbeOf(server);

  const service = probe.services.find((entry) => entry.id === id);
  if (!service) {
    throw new ApiError(
      msg('Auf "{server}" gibt es kein Ziel mit der ID "{id}".', { server: server.name, id }),
      404
    );
  }

  const surface = surfaceTarget(probe.services, { publicUrl: (await getSettings()).publicUrl });
  return serviceView(server, service, serviceHealth(service, probe.serverStates), surface);
}

/** Was eine schreibende Funktion zurückgibt: der Lauf, den der Aufrufer abfragt. */
export interface ServiceRunStarted {
  runId: string;
  serverId: string;
  serviceId: string;
}

/**
 * Ein Ziel anlegen. Der Rumpf ist der von `POST /services` (siehe
 * docs/reverse-proxy-api.md), samt `dnsHook` und `dnsDomains`.
 *
 * Was sich ohne Schreibvorgang beantworten lässt, kommt als Fehler zurück:
 * belegte Dienst-ID, fremde Domain, fehlendes acme.sh, Wildcard ohne DNS-Hook.
 */
export async function createServiceRun(
  body: Record<string, unknown>,
  actor: HaproxyActor
): Promise<ServiceRunStarted> {
  const server = await resolveProxy(body.serverId);

  // Mit dem Passwort der Sperre, falls eins mitkam (lib/haproxy/password-lock.ts).
  const draft = readServiceRequest(body);
  const invalid = validateNewService(draft);
  if (invalid) throw new ApiError(invalid);

  // Nicht Teil der Eingabe: der Hook steht in keiner Zeile der Konfiguration.
  const dnsHook = String(body.dnsHook ?? '').trim() || null;
  // Intern oder öffentlich: davon hängt ab, ob HTTP-01 überhaupt geht (`challenge.ts`).
  const challenge = { exposure: (await getSettings()).exposure, dnsHook };

  const input = await asConflict(() => precheckCreate(server, draft, challenge));

  const run = await startHaproxyRun({
    server,
    action: 'create',
    serviceId: input.id,
    input,
    challenge,
    dns: { ensure: await readDnsDomains(body.dnsDomains, input.domains) },
    actor,
  });

  return { runId: run.$id, serverId: server.$id, serviceId: input.id };
}

/**
 * Ein Ziel ändern. **Der Rumpf ist vollständig, kein Teil-Patch**: wer nur
 * `servers` schickt, bekommt einen Eintrag ohne Domains, und die Prüfung lehnt
 * ihn ab. Ohne `id` im Rumpf behält der Eintrag seine.
 */
export async function updateServiceRun(
  id: string,
  body: Record<string, unknown>,
  actor: HaproxyActor
): Promise<ServiceRunStarted> {
  const server = await resolveProxy(body.serverId);

  const sent = readServiceRequest(body);
  const input = sent.id === '' ? { ...sent, id } : sent;
  const invalid = validateCreateInput(input);
  if (invalid) throw new ApiError(invalid);

  const dnsHook = String(body.dnsHook ?? '').trim() || null;
  const settings = await getSettings();
  const challenge = { exposure: settings.exposure, dnsHook };
  // Das Ziel, über das die Oberfläche läuft, behält deren Domain (`protected.ts`).
  const protection = { publicUrl: settings.publicUrl };

  const current = await asConflict(() => precheckUpdate(server, id, input, challenge, protection));

  // Was aus der Domainliste herausfällt, verliert auch seinen DNS-Eintrag,
  // aber nur, wenn es unserer ist. Der Vergleich muss VOR dem Schreiben
  // passieren: danach steht in der Konfiguration nur noch die neue Liste.
  const kept = new Set(input.domains.map((d) => d.toLowerCase()));
  const dropped = current.domains.filter((domain) => !kept.has(domain.toLowerCase()));

  const run = await startHaproxyRun({
    server,
    action: 'update',
    serviceId: id,
    input,
    challenge,
    protection,
    dns: {
      ensure: await readDnsDomains(body.dnsDomains, input.domains),
      remove: dropped,
    },
    actor,
  });

  return { runId: run.$id, serverId: server.$id, serviceId: input.id };
}

/**
 * Ein Ziel entfernen. `removeDns` fehlt heißt: die DNS-Einträge bleiben
 * stehen. Entfernt wird ohnehin nur, was HAPM selbst gesetzt hat. Das Ziel der
 * Oberfläche lässt sich nicht entfernen (409).
 */
export async function deleteServiceRun(
  id: string,
  options: { serverId?: string | null; removeDns?: boolean },
  actor: HaproxyActor
): Promise<ServiceRunStarted> {
  const server = await resolveProxy(options.serverId);
  const protection = { publicUrl: (await getSettings()).publicUrl };

  // Liest den Dienst, wie er JETZT dasteht: Domains und Ziele gehen
  // denormalisiert in die Historie, danach gibt es sie nirgends mehr.
  const current = await asConflict(() => precheckDelete(server, id, protection));

  const run = await startHaproxyRun({
    server,
    action: 'delete',
    serviceId: id,
    service: current,
    protection,
    dns: { remove: options.removeDns === true ? current.domains : [] },
    actor,
  });

  return { runId: run.$id, serverId: server.$id, serviceId: id };
}

/* ── TCP-Weiterleitungen ── */

export interface StreamList {
  streams: StreamView[];
  unreachable: Unreachable[];
}

export async function listStreams(
  filter: { serverId?: string | null; scope?: string | null },
  t: Translate
): Promise<StreamList> {
  const servers = await readServers(filter.serverId);
  const scope = filter.scope?.trim().toUpperCase() || null;
  const response: StreamList = { streams: [], unreachable: [] };

  await Promise.all(
    servers.map(async (server) => {
      try {
        const probe = await probeProxy(server);
        if (!probe.configReadable) {
          response.unreachable.push({
            serverId: server.$id,
            serverName: server.name,
            error: t('Die HAProxy-Konfiguration ist nicht lesbar.'),
          });
          return;
        }
        response.streams.push(...streamsOf(server, probe));
      } catch (err) {
        response.unreachable.push({
          serverId: server.$id,
          serverName: server.name,
          error: err instanceof Error ? err.message : t('HAProxy ist nicht erreichbar.'),
        });
      }
    })
  );

  if (scope) {
    response.streams = response.streams.filter((s) => (s.scope ?? '').toUpperCase() === scope);
  }
  response.streams.sort(
    (a, b) => a.serverName.localeCompare(b.serverName, 'de') || a.id.localeCompare(b.id, 'de')
  );
  return response;
}

/**
 * Ist ein Port frei? `haproxy -c` bindet keine Sockets: ein belegter Port kommt
 * durch die Prüfung und scheitert erst beim Reload. `free: true` mit gesetztem
 * `reason` heißt „ließ sich nicht feststellen" und ist keine Zusage.
 */
export async function checkPort(
  rawPort: unknown,
  options: { serverId?: string | null; exclude?: string | null },
  t: Translate
) {
  const port = Number(String(rawPort ?? '').trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ApiError(msg('port muss eine ganze Zahl zwischen {min} und {max} sein.', { min: 1, max: 65535 }));
  }
  const server = await resolveProxy(options.serverId);
  const exclude = options.exclude?.trim() || undefined;
  return {
    serverId: server.$id,
    serverName: server.name,
    port,
    ...(await checkStreamPort(server, port, exclude, t)),
  };
}

export async function getStream(id: string, serverId?: string | null): Promise<StreamView> {
  const server = await resolveProxy(serverId);
  const probe = await readableProbeOf(server);

  const stream = probe.streams.find((entry) => entry.id === id);
  if (!stream) {
    throw new ApiError(
      msg('Auf "{server}" gibt es keine TCP-Weiterleitung mit der Kennung "{id}".', { server: server.name, id }),
      404
    );
  }
  // Ein `listen`-Abschnitt taucht in `show stat` unter seinem Namen auf wie
  // jedes Backend, hat aber keine Pfad-Regeln.
  return streamView(server, stream, serviceHealth({ id: stream.id, routes: [] }, probe.serverStates));
}

export interface StreamRunStarted {
  runId: string;
  serverId: string;
  streamId: string;
}

/** Ohne `allowedSources` ist der Port von überall erreichbar. */
export async function createStreamRun(
  body: Record<string, unknown>,
  actor: HaproxyActor
): Promise<StreamRunStarted> {
  const server = await resolveProxy(body.serverId);

  const draft = readStreamInput(body);
  const invalid = validateNewStream(draft);
  if (invalid) throw new ApiError(invalid);

  const input = await asConflict(() => precheckStreamCreate(server, draft));

  const run = await startHaproxyRun({
    server,
    action: 'stream-create',
    serviceId: input.id,
    streamInput: input,
    actor,
  });
  return { runId: run.$id, serverId: server.$id, streamId: input.id };
}

/** Vollständiger Rumpf. `allowedSources` wegzulassen setzt die Liste auf leer. */
export async function updateStreamRun(
  id: string,
  body: Record<string, unknown>,
  actor: HaproxyActor
): Promise<StreamRunStarted> {
  const server = await resolveProxy(body.serverId);

  const sent = readStreamInput(body);
  const input = sent.id === '' ? { ...sent, id } : sent;
  const invalid = validateStreamInput(input);
  if (invalid) throw new ApiError(invalid);

  await asConflict(() => precheckStreamUpdate(server, id, input));

  const run = await startHaproxyRun({
    server,
    action: 'stream-update',
    serviceId: id,
    streamInput: input,
    actor,
  });
  return { runId: run.$id, serverId: server.$id, streamId: input.id };
}

export async function deleteStreamRun(
  id: string,
  options: { serverId?: string | null },
  actor: HaproxyActor
): Promise<StreamRunStarted> {
  const server = await resolveProxy(options.serverId);
  // Port und Ziele gehen denormalisiert in die Historie.
  const stream = await asConflict(() => precheckStreamDelete(server, id));

  const run = await startHaproxyRun({
    server,
    action: 'stream-delete',
    serviceId: id,
    stream,
    actor,
  });
  return { runId: run.$id, serverId: server.$id, streamId: id };
}

/* ── Läufe ── */

export const RUN_STATUSES: RunStatus[] = ['running', 'success', 'warning', 'error', 'cancelled'];

/** Dieselbe Allow-Liste wie im Sitzungs-Weg. Was hier fehlt, wird still
 *  ignoriert und liefert ungefiltert alles. */
export const RUN_ACTIONS: HaproxyAction[] = [
  'create',
  'update',
  'delete',
  'settings',
  'scope-add',
  'scope-remove',
  'stream-create',
  'stream-update',
  'stream-delete',
  'certificate',
  'import',
];

export interface RunFilter {
  serverId?: string | null;
  serviceId?: string | null;
  status?: string | null;
  action?: string | null;
  mine?: boolean;
  limit?: number | null;
  offset?: number | null;
}

/**
 * Die Historie. `mine` grenzt auf die Vorgänge über ein Token ein (API und
 * MCP), gefiltert über `triggeredByTokenId` und nicht über den Namen: ein
 * Mensch und ein Token stehen beide mit ihrem Namen in `triggeredBy`.
 */
export async function listRuns(filter: RunFilter) {
  const limit = Math.min(Math.max(Number(filter.limit ?? 25) || 25, 1), 100);
  const offset = Math.max(Number(filter.offset ?? 0) || 0, 0);
  const { serverId, serviceId, status, action } = filter;

  const runs = await listDocuments<HaproxyRun>(COLLECTIONS.HAPROXY_RUNS, [
    ...(serverId ? [Query.equal('serverId', serverId)] : []),
    // Auch die Kennung einer TCP-Weiterleitung steht in dieser Spalte.
    ...(serviceId ? [Query.equal('serviceId', serviceId)] : []),
    ...(filter.mine ? [Query.isNotNull('triggeredByTokenId')] : []),
    ...(status && RUN_STATUSES.includes(status as RunStatus) ? [Query.equal('status', status)] : []),
    ...(action && RUN_ACTIONS.includes(action as HaproxyAction) ? [Query.equal('action', action)] : []),
    Query.orderDesc('startedAt'),
    Query.limit(limit),
    Query.offset(offset),
  ]);

  return runs.map((run) => ({
    id: run.$id,
    serverId: run.serverId,
    serverName: run.serverName,
    action: run.action,
    serviceId: run.serviceId,
    renamedTo: run.renamedTo,
    // Bei einer TCP-Weiterleitung steht hier der Port statt der Domains.
    domains: run.domains,
    targets: run.targets,
    status: run.status,
    phase: run.phase,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    duration: run.duration,
    error: run.error,
    steps: parseSteps(run.steps),
    triggeredBy: run.triggeredBy,
  }));
}

export type RunView = Awaited<ReturnType<typeof getRun>>;

/**
 * Der Stand eines Vorgangs. **`status: 'error'` heißt nicht, dass nichts
 * passiert ist**: was durchkam, sagen die Schritte.
 */
export async function getRun(id: string, t: Translate) {
  let run: HaproxyRun;
  try {
    run = await getDocument<HaproxyRun>(COLLECTIONS.HAPROXY_RUNS, id);
  } catch {
    throw new ApiError(msg('Reverse-Proxy-Vorgang nicht gefunden.'), 404);
  }

  const steps = parseSteps(run.steps);
  return {
    id: run.$id,
    serverId: run.serverId,
    serverName: run.serverName,
    action: run.action,
    serviceId: run.serviceId,
    renamedTo: run.renamedTo,
    status: run.status,
    phase: run.phase,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    duration: run.duration,
    error: run.error === null ? null : t(run.error),
    steps,
    log: stepsAsLog(steps, t),
  };
}

/* ── Einstellungen ── */

export async function getProxySettings(serverId?: string | null) {
  const server = await resolveProxy(serverId);
  const { settings, dnsHooks } = await readGlobalSettings(server);
  return {
    serverId: server.$id,
    serverName: server.name,
    httpsLines: settings.httpsLines,
    adminIps: settings.adminIps,
    adminEditable: settings.adminEditable,
    lockedServices: settings.lockedServices,
    editable: settingsEditable(settings),
    dnsHooks,
  };
}

/**
 * Der einzige Teil-Patch: was nicht im Rumpf steht, bleibt stehen. `adminIps`
 * zusammen mit `addAdminIps`/`removeAdminIps` wird abgelehnt
 * (`readGlobalSettingsPatch`).
 */
export async function patchProxySettings(body: Record<string, unknown>, actor: HaproxyActor) {
  const server = await resolveProxy(body.serverId);

  // Der Ist-Stand ist die Grundlage des Patches. Der Lauf liest ihn im Lock
  // noch einmal samt Prüfsummenvergleich.
  const { settings } = await readGlobalSettings(server);
  const input = readGlobalSettingsPatch(body, settings);
  if ('error' in input) throw new ApiError(input.error);

  const invalid = validateGlobalSettings(input);
  if (invalid) throw new ApiError(invalid);

  await asConflict(() => precheckSettings(server, input));

  const run = await startHaproxyRun({
    server,
    action: 'settings',
    serviceId: 'globale-einstellungen',
    settings: input,
    actor,
  });
  return { runId: run.$id, serverId: server.$id, adminIps: input.adminIps };
}

/* ── Zertifikate ── */

/** Was acme.sh führt, samt der Dienste, die es benutzen. Nur lesend. */
export async function listCertificates(serverId: string | null | undefined, t: Translate) {
  const servers = await readServers(serverId);

  return Promise.all(
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
            // Leer heißt: von Hand ausgestellt oder von einem gelöschten Dienst übrig.
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
          error: err instanceof Error ? err.message : t('HAProxy ist nicht erreichbar.'),
        };
      }
    })
  );
}
