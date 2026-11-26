/**
 * Die Werkzeuge des MCP-Servers: Name, Beschreibung, Schema, Hinweise und die
 * Funktion, die sie aufrufen.
 *
 * ── Was hier steht und was nicht ──
 *
 * Kein Werkzeug hat eigene Logik. Jedes ruft eine Funktion, die auch eine
 * Route unter `/api/internal` ruft: `lib/haproxy/api-actions.ts` für den
 * Reverse-Proxy, dazu die `*-actions.ts` und `actions.ts` der übrigen Bereiche
 * (Updates, Sicherung, Einstellungen, Zertifikate, Grundkonfiguration,
 * Fehlerseiten, GeoIP) und die Lesefunktionen der Seiten (`systemOverview`,
 * `readStatsOverview`, `checkZones`, `readHaproxyLog`, `readAuditLog`). Damit gelten dieselben
 * Prüfungen, dieselbe Vorabprüfung, derselbe Schutz des Ziels der Oberfläche
 * und dasselbe Protokoll, ohne dass sie hier ein zweites Mal stehen. Die
 * Tabelle, welche Route zu welchem Werkzeug gehört, steht in docs/mcp.md.
 *
 * Die Schemas prüfen nur die Form (Typen, Aufzählungen). Was eine gültige
 * Domain oder ein freier Port ist, entscheidet die Bibliothek, mit derselben
 * Meldung wie bei der API.
 *
 * ── Warum Englisch ──
 *
 * Beschreibungen und Schemas liest ein Sprachmodell, nicht ein Mensch in der
 * Oberfläche. Sie sind deshalb englisch und stehen nicht im Wörterbuch
 * (docs/i18n.md, „Was nicht übersetzt wird": Felder und Werte der API). Die
 * Meldungen, die ein Werkzeug zurückgibt, kommen dagegen aus der Bibliothek
 * und sind übersetzt (`lib/mcp/locale.ts`).
 *
 * ── Rechte ──
 *
 * Ein Token hat keine Bereiche (`lib/service-auth.ts`). Jedes Werkzeug läuft
 * mit allen Rechten des Tokens, wie jede Route unter `/api/internal`.
 * Schreibende Werkzeuge reichen `ctx.actor` in den Lauf, damit Historie und
 * Audit den Namen des Tokens tragen.
 */

import { z } from 'zod';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Locale } from '../i18n';
import type { HaproxyActor } from '../haproxy/runner';
import { HAPROXY_BALANCE, isBackendTls } from '../haproxy/config';
import { STREAM_BALANCE } from '../haproxy/streams';
import {
  RUN_ACTIONS,
  RUN_STATUSES,
  changeScope,
  checkPort,
  createServiceRun,
  createStreamRun,
  deleteServiceRun,
  deleteStreamRun,
  getProxySettings,
  getRun,
  getService,
  getStream,
  listCertificates,
  listProxies,
  listRuns,
  listServices,
  listStreams,
  patchProxySettings,
  updateServiceRun,
  updateStreamRun,
  type RunView,
  type Translate,
} from '../haproxy/api-actions';
import { systemOverview } from '../system/overview';
import { readStatsOverview } from '../haproxy/stats-overview';
import { checkZones } from '../dns/zone-check';
import { UPDATE_COMPONENTS, checkUpdatesNow, getUpdateRun, startComponentUpdate, updatesOverview } from '../updates/actions';
import { backupOverview, changeBackupSettings, getBackupRun, startBackupRun } from '../backup/actions';
import { getSyncRun, startSyncRun, syncOverview } from '../sync/actions';
import {
  changeCertificateSettings,
  changeSettings,
  readServiceSettingsInput,
  sendTestMailAs,
  settingsOverview,
} from '../settings-actions';
import { EXPOSURES, CERTIFICATE_SOURCES } from '../settings';
import {
  addAllowlist,
  addDecision,
  assertRulesWritable,
  changeRules,
  clearCrowdsec,
  crowdsecOverview,
  setCrowdsecEnabled,
  crowdsecRules,
  crowdsecStatistics,
  listAlerts,
  listAllowlist,
  listDecisions,
  removeAllowlist,
  removeDecision,
} from '../crowdsec/actions';
import { ALLOW_DURATIONS, BAN_DURATIONS } from '../crowdsec/data';
import { CRS_MODES } from '../crowdsec/files';
import { checkAddressMove } from '../address-move';
import { reissueCertificate, removeCertificate } from '../haproxy/certificate-actions';
import {
  listCertificateAuthorities,
  removeCertificateAuthority,
  saveCertificateAuthority,
} from '../haproxy/ca-actions';
import {
  applyBaseConfig,
  readBaseConfigRows,
  readErrorPageRows,
  redeployErrorPages,
} from '../haproxy/maintenance-actions';
import { readHaproxyLog } from '../haproxy/log-read';
import { LOG_FILTERS } from '../haproxy/log-view';
import { AUDIT_ACTOR_TYPES, AUDIT_PAGE_MAX, readAuditLog, readAuditQuery } from '../audit-log/read';
import { AUDIT_AREAS } from '../audit-log/labels';
import { haproxyContainer, restartHaproxy } from '../system/haproxy-container';
import { geoipOverview } from '../geoip/fetch';
import { changeGeoipAutoRefresh, refreshGeoipNow } from '../geoip/actions';
import { LOCALES } from '../i18n/locale';
import { NOTIFICATION_EVENT_TYPES } from '../types';

export interface ToolContext {
  /** Wer schreibt: der Name des Tokens, für Lauf und Audit. */
  actor: HaproxyActor;
  locale: Locale;
  t: Translate;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  input: z.ZodRawShape;
  annotations: ToolAnnotations;
  /** Schreibt etwas (startet einen Lauf). Gegenstück zu `readOnlyHint`. */
  writes: boolean;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

function defineTool<S extends z.ZodRawShape>(def: {
  name: string;
  title: string;
  description: string;
  input: S;
  annotations: Omit<ToolAnnotations, 'title'>;
  run: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<unknown>;
}): ToolDefinition {
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    input: def.input,
    annotations: { title: def.title, ...def.annotations },
    writes: def.annotations.readOnlyHint !== true,
    run: def.run as ToolDefinition['run'],
  };
}

/** Wie lange `get_run` höchstens wartet. Unter den üblichen Timeouts der
 *  Clients für einen Werkzeugaufruf (60 s), damit die Antwort ankommt. */
export const MAX_WAIT_SECONDS = 50;
const POLL_MS = 2000;

/** Hinweis an das Modell nach einem gestarteten Lauf. */
const NEXT_STEP =
  'The change runs in the background (DNS, certificate, haproxy -c, reload) and can take up to 5 minutes. ' +
  'Call get_run with this runId and waitSeconds=50, repeatedly, until status is no longer "running". ' +
  'status "error" does not mean nothing happened: read steps.';

function started<T extends object>(result: T) {
  return { ...result, next: NEXT_STEP };
}

/* ── Gemeinsame Teile der Schemas ── */

const READ_ONLY: Omit<ToolAnnotations, 'title'> = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const serverEntry = z.object({
  name: z
    .string()
    .optional()
    .describe('Server name inside the backend. May be empty: then server1, server2, ...'),
  target: z.string().describe('host:port of the upstream, e.g. "10.0.0.12:3000".'),
  weight: z
    .number()
    .int()
    .min(0)
    .max(256)
    .nullable()
    .optional()
    .describe(
      'Share relative to the other servers, 0 to 256. Omit or null: no weight line, HAProxy default applies (NOT 1). ' +
        '0 drains a server without dropping its sticky sessions.'
    ),
});

/** Dieselbe Allow-Liste wie `validateCreateInput`; das Schema sagt es nur früher. */
const backendTls = z
  .string()
  .refine(isBackendTls, {
    message: 'Expected "off", "insecure", "verify" or "ca:<name>" (name from list_certificate_authorities).',
  })
  .optional()
  .describe(
    'How HAProxy talks to the upstream. Omit or "off": plain HTTP. "insecure": HTTPS without checking the certificate ' +
      '(self-signed, e.g. Proxmox on 8006, TrueNAS). "verify": HTTPS, certificate checked against the system CAs ' +
      '(needs HAProxy 2.6+). "ca:<name>": HTTPS, certificate checked against a stored certificate authority, ' +
      'for upstreams with a certificate from an internal CA (names from list_certificate_authorities, e.g. "ca:intern-root"). ' +
      'All HTTPS modes send the request Host as SNI; when checking, the upstream certificate must be valid for the requested domain.'
  );

const backendVerifyHost = z
  .string()
  .nullable()
  .optional()
  .describe(
    'Name the upstream certificate is checked against instead of the requested domain, e.g. "app01.intern.example". ' +
      'For upstreams whose certificate only names their internal hostname (typical with an internal CA). ' +
      'HAProxy then sends this name as SNI (also for the health check) and verifies the certificate against it; ' +
      'the Host header sent to the upstream stays the requested domain. Lowercase hostname, no wildcard, no port, no IP address. ' +
      'Only with backendTls "verify" or "ca:<name>"; ignored and not stored with "off" and "insecure". Omit or null: the requested domain.'
  );

const routeEntry = z.object({
  name: z.string().describe('Rule name, a-z 0-9 _, e.g. "terminal".'),
  paths: z
    .array(z.string())
    .describe('Path prefixes starting with "/", no spaces, each path only once across all rules, e.g. ["/terminal"].'),
  servers: z
    .array(serverEntry.omit({ weight: true }))
    .describe('Upstreams for these paths. No weight: a path rule separates traffic, it does not balance it.'),
  check: z
    .boolean()
    .optional()
    .describe('Plain TCP check on these upstreams (no HTTP check: a WebSocket endpoint does not answer GET / with 200).'),
  backendTls: backendTls.describe(
    'Own setting per rule, not inherited from the target: off, insecure, verify or ca:<name> (see backendTls of the target).'
  ),
  backendVerifyHost: backendVerifyHost.describe(
    'Own setting per rule, not inherited from the target (see backendVerifyHost of the target).'
  ),
});

const headerRule = z.object({
  name: z.string().describe('Header name: letters, digits, hyphen. Hop-by-hop headers (Connection, Upgrade, ...) are rejected.'),
  value: z.string().describe('Literal printable ASCII up to 1024 chars. %[src] etc. is sent as text, not evaluated.'),
});

/** Die Felder eines Ziels, wie `POST /services` sie nimmt (docs/reverse-proxy-api.md). */
const serviceFields = {
  scope: z
    .string()
    .describe('Scope (group) the target lives in, as listed by get_proxy, e.g. "KUNDEN". Required.'),
  domains: z
    .array(z.string())
    .min(1)
    .describe(
      'Lower-case domains, at least one. domains[0] is the main domain (PEM file name, Host header of the health check). ' +
        'Wildcards are written "*.example.com".'
    ),
  servers: z
    .array(serverEntry)
    .optional()
    .describe('Upstreams. Required unless redirect is set. More than one means load balancing.'),
  redirect: z
    .object({
      to: z.string().describe('Absolute URL with scheme, e.g. "https://example.com". No spaces, # or quotes.'),
      keepPath: z.boolean().optional().describe('true appends path and query (/prices -> .../prices).'),
      permanent: z.boolean().optional().describe('true = 301, otherwise 302.'),
    })
    .nullable()
    .optional()
    .describe('Redirect the domains instead of proxying them. Excludes servers, routes, headers, tunnel, balance, sticky and backendTls.'),
  routes: z
    .array(routeEntry)
    .optional()
    .describe('Path rules: same domain, different upstream (e.g. Coolify: UI on 8000, terminal on 6002).'),
  balance: z
    .enum(HAPROXY_BALANCE)
    .nullable()
    .optional()
    .describe('Load balancing algorithm. Omit or null: no balance line, the defaults section applies (not roundrobin).'),
  sticky: z
    .boolean()
    .optional()
    .describe('Session affinity via a cookie set by HAProxy. Needed for apps that keep sessions in memory.'),
  lockedDomains: z
    .array(z.string())
    .optional()
    .describe(
      'Domains of this target that only admin IPs may reach (HTTP 403 for everyone else), or that ask for a password if lockPassword is set. ' +
        'Locking to admin IPs requires admin IPs to be configured (get_proxy_settings).'
    ),
  lockPassword: z
    .string()
    .optional()
    .describe('8 to 128 characters. Locks lockedDomains with a password prompt instead of admin IPs. Only a hash is stored.'),
  responseHeaders: z
    .array(headerRule)
    .max(20)
    .optional()
    .describe('Fixed headers sent to the visitor, e.g. [{"name":"X-Frame-Options","value":"SAMEORIGIN"}].'),
  requestHeaders: z.array(headerRule).max(20).optional().describe('Fixed headers sent to the upstream.'),
  tunnel: z
    .boolean()
    .optional()
    .describe('true writes "timeout tunnel 1h": keeps WebSocket, terminal and live views open. Default false.'),
  crowdsec: z
    .boolean()
    .optional()
    .describe(
      'true sends every request of this service through CrowdSec (WAF and IP bans, 403 on a hit). Default false. ' +
        'Not needed when CrowdSec is on for all services (get_proxy_settings: crowdsec). Ignored with redirect.'
    ),
  app: z
    .string()
    .nullable()
    .optional()
    .describe(
      'The application behind this service, an id from get_crowdsec_rules (apps), e.g. "nextcloud". HAPM then exempts its known ' +
        'false bans from CrowdSec for this service only. Omit or null: none. Ignored with redirect.'
    ),
  healthcheck: z
    .boolean()
    .optional()
    .describe('HTTP health check against domains[0]. Default false. Ignored when domains[0] is a wildcard or redirect is set.'),
  backendTls,
  backendVerifyHost,
  dnsDomains: z
    .union([z.literal('auto'), z.array(z.string())])
    .optional()
    .describe(
      'Which domains get a DNS record (CNAME to the zone apex). Omit: DNS is not touched. ' +
        '"auto": every domain that has a connected zone (see list_dns_zones), except the zone apex itself. ' +
        'A list: exactly these, intersected with domains.'
    ),
  dnsHook: z
    .string()
    .optional()
    .describe('acme.sh DNS hook for DNS-01 (from get_proxy dnsHooks, e.g. "dns_cf"). Only needed when more than one hook is set up.'),
};

const streamFields = {
  scope: z.string().describe('Scope (group), as listed by get_proxy. Required.'),
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .describe('Public port on this server. 22, 80, 443 and 8888 are refused. Check with check_port first.'),
  servers: z.array(serverEntry).min(1).describe('Upstreams, e.g. [{"target":"10.0.0.50:5432"}].'),
  balance: z
    .enum(STREAM_BALANCE)
    .nullable()
    .optional()
    .describe('Load balancing algorithm. "uri" does not exist in TCP mode. Omit or null: defaults section applies.'),
  check: z.boolean().optional().describe('TCP connect check on the upstreams. Default false.'),
  allowedSources: z
    .array(z.string())
    .optional()
    .describe(
      'IPs or CIDR ranges allowed to connect, e.g. ["10.0.0.0/8"]. EMPTY OR OMITTED MEANS: REACHABLE FROM EVERYWHERE. ' +
        'On update, omitting it resets the list to empty; it is not inherited.'
    ),
};

/** Ein Lauf, bis er fertig ist oder die Wartezeit um ist. */
async function waitFor<T extends { status: string }>(read: () => Promise<T>, waitSeconds: number): Promise<T> {
  const until = Date.now() + Math.min(Math.max(waitSeconds, 0), MAX_WAIT_SECONDS) * 1000;
  let run = await read();
  while (run.status === 'running' && Date.now() + POLL_MS <= until) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    run = await read();
  }
  return run;
}

function waitForRun(runId: string, waitSeconds: number, t: Translate): Promise<RunView> {
  return waitFor(() => getRun(runId, t), waitSeconds);
}

/** Der Actor für Funktionen außerhalb des Reverse-Proxys, die ins Protokoll schreiben. */
function auditActor(actor: HaproxyActor) {
  return { userId: actor.userId, userEmail: actor.email, ...(actor.ip ? { ip: actor.ip } : {}) };
}

const waitSecondsInput = z
  .number()
  .int()
  .min(0)
  .max(MAX_WAIT_SECONDS)
  .optional()
  .describe(`Wait up to this many seconds for the run to finish. Default 0 (return at once).`);

/** Hinweis an das Modell nach einem gestarteten Update. */
const UPDATE_NEXT =
  'The update runs in the background. Call get_update_run with this runId and waitSeconds=50 until status is no longer "running". ' +
  'For component "hapm" the HAPM container replaces itself: this MCP connection fails for about a minute, ' +
  'then call get_update_run again; the new container closes the run when it starts.';

/** Ein Lauf in der Übersicht, ohne seine Schritte: die liefern get_update_run und get_backup_run. */
function runSummary<T extends { $id: string; steps: unknown }>(run: T) {
  const { steps: _steps, ...rest } = run;
  void _steps;
  return rest;
}

/* ── Die Werkzeuge ── */

export const TOOLS: ToolDefinition[] = [
  defineTool({
    name: 'get_proxy',
    title: 'HAProxy overview',
    description:
      'Start here. Returns the one HAProxy that HAPM manages: version, scopes (groups) with their names, admin IPs, ' +
      'configured acme.sh DNS hooks, acmeReady and the number of targets and TCP forwards. ' +
      'You need a scope name from this list to create a target or a TCP forward. ' +
      'acmeReady=false means certificates cannot be issued, so targets with domains cannot be created. ' +
      'error set means the configuration could not be read.',
    input: {},
    annotations: READ_ONLY,
    run: async (_args, ctx) => (await listProxies(ctx.t))[0] ?? null,
  }),

  defineTool({
    name: 'list_services',
    title: 'List targets',
    description:
      'Lists the reverse proxy targets (HTTP services: domains -> upstream servers). ' +
      'Filter by scope or by exact domain (no substring match: "example.com" does not match "app.example.com"). ' +
      'Always check "unreachable" before concluding from an empty list: it means the configuration could not be read. ' +
      'Each target carries editable/removable/surface flags and health (up, down, partial, unknown).',
    input: {
      scope: z.string().optional().describe('Only targets in this scope, e.g. "KUNDEN".'),
      domain: z.string().optional().describe('Only targets serving exactly this domain, e.g. "shop.example.com".'),
    },
    annotations: READ_ONLY,
    run: (args, ctx) => listServices({ scope: args.scope, domain: args.domain }, ctx.t),
  }),

  defineTool({
    name: 'get_service',
    title: 'Get target',
    description:
      'Returns one target with all its fields. Use it before update_service: the update takes the COMPLETE definition, ' +
      'so read, change what you need, send everything back. editable=false means update_service will be refused (see extras). ' +
      'surface=true means HAPM itself is reached through this target: it cannot be deleted and must keep the HAPM domain.',
    input: { id: z.string().describe('Target ID (= backend name), e.g. "shop_example_com".') },
    annotations: READ_ONLY,
    run: (args) => getService(args.id),
  }),

  defineTool({
    name: 'create_service',
    title: 'Create target',
    description:
      'Creates a reverse proxy target: domains routed to upstream servers, with a Let\'s Encrypt certificate and optionally DNS records. ' +
      'Side effects: may create DNS records at the DNS provider, requests a certificate, rewrites haproxy.cfg and reloads HAProxy. ' +
      'Returns { runId, serviceId } immediately; the work runs in the background, poll get_run. ' +
      'Input errors that need no write (ID taken, domain already served by another target, acme.sh missing, wildcard without DNS hook) ' +
      'come back immediately as an error. ' +
      'Minimal example: {"scope":"KUNDEN","domains":["shop.example.com"],"servers":[{"target":"10.0.0.12:3000"}],"healthcheck":true,"dnsDomains":"auto"}.',
    input: {
      ...serviceFields,
      id: z
        .string()
        .optional()
        .describe('Optional target ID, a-z 0-9 _. Omit it: derived from domains[0] (shop.example.com -> shop_example_com) and returned as serviceId.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: async (args, ctx) => started(await createServiceRun(args, ctx.actor)),
  }),

  defineTool({
    name: 'update_service',
    title: 'Update target',
    description:
      'Replaces a target with a COMPLETE new definition. This is not a partial patch: every field you omit is reset ' +
      '(servers, routes, headers, tunnel, healthcheck, backendTls, backendVerifyHost, lockedDomains). Always call get_service first, modify its result, and send all fields. ' +
      'Exception: omitting passwordLock keeps the current lock type and password. ' +
      'Domains removed from the list lose their DNS record if HAPM created it. ' +
      'Refused when editable=false, and for the surface target when the HAPM domain would be removed. ' +
      'Side effects: may change DNS records, may request a certificate, rewrites haproxy.cfg and reloads HAProxy. Returns { runId }; poll get_run.',
    input: {
      id: z.string().describe('CURRENT target ID.'),
      newId: z.string().optional().describe('Set only to rename the target (renames ACL and backend). Omit to keep the ID.'),
      ...serviceFields,
      passwordLock: z
        .literal('unchanged')
        .nullable()
        .optional()
        .describe('Omit: keep the current lock type. "unchanged": require that the existing password stays. null: switch the lock to admin IPs.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    run: async ({ id, newId, ...rest }, ctx) =>
      started(await updateServiceRun(id, { ...rest, id: newId ?? '' }, ctx.actor)),
  }),

  defineTool({
    name: 'delete_service',
    title: 'Delete target',
    description:
      'Removes a target from haproxy.cfg and reloads HAProxy: its domains stop being served. ' +
      'The certificate is removed unless another target still uses it (e.g. a shared wildcard). ' +
      'DNS records stay unless removeDns=true, and even then only records HAPM created itself are removed. ' +
      'The surface target (through which HAPM itself is reached) cannot be deleted. Returns { runId }; poll get_run.',
    input: {
      id: z.string().describe('Target ID.'),
      removeDns: z.boolean().optional().describe('Also remove the DNS records HAPM created for its domains. Default false.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    run: async (args, ctx) =>
      started(await deleteServiceRun(args.id, { removeDns: args.removeDns === true }, ctx.actor)),
  }),

  defineTool({
    name: 'list_streams',
    title: 'List TCP forwards',
    description:
      'Lists TCP forwards: a port on this server passed through to upstream servers (no HTTP, no domain, no certificate). ' +
      'allowedSources empty means reachable from everywhere. Check "unreachable" before trusting an empty list.',
    input: { scope: z.string().optional().describe('Only forwards in this scope.') },
    annotations: READ_ONLY,
    run: (args, ctx) => listStreams({ scope: args.scope }, ctx.t),
  }),

  defineTool({
    name: 'get_stream',
    title: 'Get TCP forward',
    description: 'Returns one TCP forward with all its fields. Use it before update_stream, which takes the complete definition.',
    input: { id: z.string().describe('Forward ID (= name of the listen section), e.g. "tcp_5432".') },
    annotations: READ_ONLY,
    run: (args) => getStream(args.id),
  }),

  defineTool({
    name: 'check_port',
    title: 'Check port',
    description:
      'Tells whether a port is free for a TCP forward: not bound in haproxy.cfg and nobody listens on it. ' +
      'Ask before create_stream: haproxy -c does not bind sockets, so a taken port would only fail on reload. ' +
      'free=true with a reason means "could not be determined", not a promise.',
    input: {
      port: z.number().int().min(1).max(65535).describe('Port to check, e.g. 5432.'),
      exclude: z.string().optional().describe('When changing a forward: its own ID, so it does not conflict with itself.'),
    },
    annotations: READ_ONLY,
    run: (args, ctx) => checkPort(args.port, { exclude: args.exclude }, ctx.t),
  }),

  defineTool({
    name: 'create_stream',
    title: 'Create TCP forward',
    description:
      'Creates a TCP forward: HAProxy listens on port and passes connections to servers. ' +
      'Without allowedSources the port is open to everyone. This does not open any firewall. ' +
      'Side effects: rewrites haproxy.cfg and reloads HAProxy. Returns { runId, streamId }; poll get_run. ' +
      'Example: {"scope":"KUNDEN","port":5432,"servers":[{"target":"10.0.0.50:5432"}],"check":true,"allowedSources":["10.0.0.0/8"]}.',
    input: {
      ...streamFields,
      id: z.string().optional().describe('Optional ID, a-z 0-9 _. Omit it: tcp_<port>, returned as streamId.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: async (args, ctx) => started(await createStreamRun(args, ctx.actor)),
  }),

  defineTool({
    name: 'update_stream',
    title: 'Update TCP forward',
    description:
      'Replaces a TCP forward with a COMPLETE new definition. Omitted fields are reset; in particular omitting allowedSources ' +
      'makes the port reachable from everywhere. Call get_stream first and send everything back. ' +
      'Side effects: rewrites haproxy.cfg and reloads HAProxy; open connections may drop. Returns { runId }; poll get_run.',
    input: {
      id: z.string().describe('CURRENT forward ID.'),
      newId: z.string().optional().describe('Set only to rename the forward.'),
      ...streamFields,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: async ({ id, newId, ...rest }, ctx) =>
      started(await updateStreamRun(id, { ...rest, id: newId ?? '' }, ctx.actor)),
  }),

  defineTool({
    name: 'delete_stream',
    title: 'Delete TCP forward',
    description:
      'Removes a TCP forward and reloads HAProxy. The port stops accepting connections and running connections are cut. ' +
      'Returns { runId }; poll get_run.',
    input: { id: z.string().describe('Forward ID.') },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run: async (args, ctx) => started(await deleteStreamRun(args.id, {}, ctx.actor)),
  }),

  defineTool({
    name: 'create_scope',
    title: 'Create scope',
    description:
      'Creates a scope (group): a pair of marker comments in haproxy.cfg that targets and forwards live in. ' +
      'Name: 2 to 24 characters, a-z 0-9 _ -, starting with a letter. There is no rename. ' +
      'Side effects: rewrites haproxy.cfg and reloads HAProxy. Returns { runs: [{ runId }] } with exactly one run; poll get_run.',
    input: { name: z.string().describe('Scope name, e.g. "kunden".') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: async (args, ctx) => started(await changeScope(args.name, 'scope-add', ctx.actor)),
  }),

  defineTool({
    name: 'delete_scope',
    title: 'Delete scope',
    description:
      'Removes an empty scope. Refused while it contains targets or forwards, and always for the scope holding the surface target. ' +
      'Returns { runs: [{ runId }] }; poll get_run.',
    input: { name: z.string().describe('Scope name as listed by get_proxy.') },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run: async (args, ctx) => started(await changeScope(args.name, 'scope-remove', ctx.actor)),
  }),

  defineTool({
    name: 'get_proxy_settings',
    title: 'Get global settings',
    description:
      'Returns what belongs to HAProxy as a whole: the global HTTPS lines (e.g. HSTS) and the admin IP list that locked domains point to. ' +
      'lockedServices are targets currently restricted to the admin IPs; the list cannot be emptied while one exists. ' +
      'protection holds blocked IPs/networks, blocked countries (ISO codes) and the rate limit per address; null means the block was edited by hand and is read-only.',
    input: {},
    annotations: READ_ONLY,
    run: () => getProxySettings(),
  }),

  defineTool({
    name: 'update_proxy_settings',
    title: 'Update global settings',
    description:
      'Partial update of the global settings: only the fields you send change. ' +
      'Use addAdminIps / removeAdminIps to change single entries, or adminIps to replace the whole list (not together). ' +
      'Removing an admin IP can lock people out of every locked domain. ' +
      'blockedIps, blockedCountries and rateLimit set the access protection for every service; admin IPs are exempt from country block and rate limit, not from blockedIps. ' +
      'Side effects: rewrites haproxy.cfg and reloads HAProxy. Returns { runId }; poll get_run. Example: {"addAdminIps":["203.0.113.7"]}.',
    input: {
      addAdminIps: z.array(z.string()).optional().describe('IPs or CIDR ranges to add.'),
      removeAdminIps: z.array(z.string()).optional().describe('IPs or CIDR ranges to remove.'),
      adminIps: z.array(z.string()).optional().describe('Replace the whole admin IP list.'),
      httpsLines: z
        .array(z.string())
        .optional()
        .describe('Replace the global HTTPS lines, e.g. ["http-response set-header Strict-Transport-Security max-age=31536000"].'),
      blockedIps: z.array(z.string()).optional().describe('Replace the list of blocked IPs or CIDR ranges (403 for every service).'),
      blockedCountries: z
        .array(z.string())
        .optional()
        .describe('Replace the blocked countries, ISO 3166 alpha-2 codes like ["RU", "CN"]. Needs the GeoIP table.'),
      rateLimit: z
        .object({
          requests: z.number().int().describe('More requests than this per period and address get 429 (10 to 100000).'),
          period: z.enum(['10s', '1m', '10m']),
        })
        .nullable()
        .optional()
        .describe('Rate limit per client address; null turns it off.'),
      crowdsec: z
        .boolean()
        .optional()
        .describe('true sends every request of every service through CrowdSec (WAF and IP bans); false only services with their own crowdsec flag.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: async (args, ctx) => started(await patchProxySettings(args, ctx.actor)),
  }),

  defineTool({
    name: 'get_run',
    title: 'Get run status',
    description:
      'Status of a background run started by a write tool: status (running, success, warning, error, cancelled), phase, steps and a text log. ' +
      `With waitSeconds (max ${MAX_WAIT_SECONDS}) the call waits until the run is finished or the time is up, so call it with ` +
      `waitSeconds=${MAX_WAIT_SECONDS} until status is not "running"; a certificate can take up to 5 minutes. ` +
      'status "error" does not mean nothing happened: a DNS record or certificate may already exist, the steps say what got through. Nothing is rolled back.',
    input: {
      runId: z.string().describe('runId returned by a write tool.'),
      waitSeconds: z
        .number()
        .int()
        .min(0)
        .max(MAX_WAIT_SECONDS)
        .optional()
        .describe(`Wait up to this many seconds for the run to finish. Default 0 (return at once).`),
    },
    annotations: READ_ONLY,
    run: (args, ctx) => waitForRun(args.runId, args.waitSeconds ?? 0, ctx.t),
  }),

  defineTool({
    name: 'list_runs',
    title: 'List runs',
    description:
      'History of reverse proxy runs, newest first. Use it to find a lost runId (filter by serviceId) or to see what changed recently. ' +
      'mine=true: only runs started through a service token (API or MCP).',
    input: {
      serviceId: z.string().optional().describe('Target or forward ID.'),
      status: z.enum(RUN_STATUSES).optional(),
      action: z.enum(RUN_ACTIONS).optional(),
      mine: z.boolean().optional().describe('Only runs started through a service token.'),
      limit: z.number().int().min(1).max(100).optional().describe('Default 25.'),
      offset: z.number().int().min(0).optional(),
    },
    annotations: READ_ONLY,
    run: (args) => listRuns(args),
  }),

  defineTool({
    name: 'list_certificates',
    title: 'List certificates',
    description:
      'Certificates managed by acme.sh with their domains, renewal date and usedBy (target IDs). ' +
      'usedBy empty means issued by hand or left over from a deleted target; createdAt null means the request was never issued. ' +
        'Certificates come and go with their targets; leftovers can be removed with delete_certificate, a pending request retried with reissue_certificate.',
    input: {},
    annotations: READ_ONLY,
    run: (_args, ctx) => listCertificates(null, ctx.t),
  }),

  defineTool({
    name: 'get_system_status',
    title: 'System status',
    description:
      'Health of the whole installation in one call: HAProxy container (running, restarts), Docker, HAPM version, acme.sh, ' +
      'targets that are down or partially down, certificates expiring soon or overdue for renewal, recent and failed runs, ' +
      'available image updates. null means unknown, not zero.',
    input: {},
    annotations: READ_ONLY,
    run: () => systemOverview(),
  }),

  defineTool({
    name: 'get_traffic_stats',
    title: 'Traffic statistics',
    description:
      'Traffic summary from the stored HAProxy metrics (collected every minute): totals for the period ' +
      '(requests, http2xx..http5xx, errors, denied, bytesInKb/bytesOutKb, average responseMs) and the targets with the most requests. ' +
      'scope here is a backend name (target or forward ID) to drill into one target. null values mean no data, not zero.',
    input: {
      hours: z.number().int().min(1).max(720).optional().describe('Period in hours, 1 to 720. Default 24.'),
      target: z.string().optional().describe('Only this target or forward ID (backend name).'),
      top: z.number().int().min(1).max(100).optional().describe('How many busiest targets to list. Default 10.'),
      includeSeries: z.boolean().optional().describe('Also return the time series (can be large). Default false.'),
    },
    annotations: READ_ONLY,
    run: async (args) => {
      const overview = await readStatsOverview({ hours: args.hours ?? 24, scope: args.target });
      return {
        hours: overview.hours,
        bucketMinutes: overview.bucketMinutes,
        samples: overview.samples,
        totals: overview.totals,
        busiest: overview.services.slice(0, args.top ?? 10).map((entry) => ({
          id: entry.scope,
          requests: entry.requests,
        })),
        ...(args.includeSeries ? { series: overview.series } : {}),
      };
    },
  }),

  defineTool({
    name: 'list_dns_zones',
    title: 'List DNS zones',
    description:
      'DNS zones connected to HAPM (Cloudflare or Hetzner) and whether their access works right now; asks the provider live. ' +
      'Domains inside these zones can get DNS records automatically (dnsDomains on create_service). ' +
      'Connecting a zone needs a provider token and is only possible in the HAPM web interface.',
    input: {},
    annotations: { ...READ_ONLY, idempotentHint: true, openWorldHint: true },
    run: (_args, ctx) => checkZones(ctx.locale),
  }),

  /* ── Updates ── */

  defineTool({
    name: 'get_updates',
    title: 'Updates overview',
    description:
      'Update state of the three components HAPM manages: "haproxy" (HAProxy container image), "hapm" (HAPM itself) and "acme" (acme.sh). ' +
      'Per component: currentVersion, latestVersion, updateAvailable (null means unknown, not "up to date"), checkedAt and error. ' +
      'Also the recent update runs (without steps), whether one is running, and the automatic update settings. ' +
      'check=true asks the registries and GitHub first, like "check now" in the web interface; nothing is downloaded or installed.',
    input: {
      check: z.boolean().optional().describe('Check the registries and GitHub before answering. Takes a few seconds. Default false.'),
    },
    annotations: { ...READ_ONLY, openWorldHint: true },
    run: async (args) => {
      const overview = args.check ? await checkUpdatesNow() : await updatesOverview();
      return { ...overview, runs: overview.runs.slice(0, 10).map(runSummary) };
    },
  }),

  defineTool({
    name: 'start_update',
    title: 'Start update',
    description:
      'Installs the latest version of one component. Only one update runs at a time (409 otherwise). ' +
      '"haproxy": pulls the image, checks the existing configuration with the new version first (nothing changes if it is rejected), ' +
      'replaces the container; the old one comes back if the new one does not start. Open connections drop. ' +
      '"hapm": replaces the HAPM container itself. THIS MCP CONNECTION BREAKS FOR ABOUT A MINUTE; afterwards call get_update_run, ' +
      'the new container closes the run when it starts. "acme": upgrades acme.sh inside HAPM. ' +
      'Check get_updates first: an update without a newer image ends with "already the running image". Returns { runId }.',
    input: {
      component: z.enum(UPDATE_COMPONENTS as [string, ...string[]]).describe('"haproxy", "hapm", "acme", "crowdsec" or "crowdsec-bouncer".'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    run: async (args, ctx) => ({
      ...(await startComponentUpdate(args.component, auditActor(ctx.actor))),
      next: UPDATE_NEXT,
    }),
  }),

  defineTool({
    name: 'get_update_run',
    title: 'Get update run',
    description:
      'Status of an update run started by start_update: status (running, success, error), fromVersion, toVersion, steps and a text log. ' +
      `With waitSeconds (max ${MAX_WAIT_SECONDS}) the call waits until the run is finished or the time is up. ` +
      'During a "hapm" update the call itself can fail while the container is replaced; wait a minute and call again.',
    input: {
      runId: z.string().describe('runId returned by start_update.'),
      waitSeconds: waitSecondsInput,
    },
    annotations: READ_ONLY,
    run: (args, ctx) => waitFor(() => getUpdateRun(args.runId, ctx.t), args.waitSeconds ?? 0),
  }),

  /* ── CrowdSec ── */

  defineTool({
    name: 'get_crowdsec',
    title: 'CrowdSec overview',
    description:
      'State of the CrowdSec WAF: whether it is part of the stack, both containers (crowdsec, bouncer), version, local API, ' +
      'which services it checks (global = all services, otherwise services with their own crowdsec flag), OWASP CRS mode, ' +
      'and counts of the last 24 hours (alerts, WAF hits, active bans, community blocklist size). Null counts mean unknown.',
    input: {},
    annotations: READ_ONLY,
    run: () => crowdsecOverview(),
  }),

  defineTool({
    name: 'set_crowdsec_enabled',
    title: 'Switch CrowdSec on or off entirely',
    description:
      '{"enabled":false} switches CrowdSec off entirely: a reverse-proxy run removes it from haproxy.cfg (global and every service). ' +
      'The call returns at once with pending=true and the runId: poll get_run. When the run succeeds, HAPM stops both containers and hides ' +
      'CrowdSec in the UI; if it fails, nothing changes and CrowdSec stays on. Without a run (pending=false, runId=null) it is off immediately. ' +
      '{"enabled":true} starts the containers again; which services are checked stays off until switched on per service or globally.',
    input: { enabled: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (args, ctx) => setCrowdsecEnabled(args, auditActor(ctx.actor)),
  }),

  defineTool({
    name: 'list_crowdsec_decisions',
    title: 'List CrowdSec bans',
    description: 'Active bans (without the community blocklist): id, value (IP or range), reason, origin, until.',
    input: {},
    annotations: { ...READ_ONLY, idempotentHint: true },
    run: async () => ({ decisions: await listDecisions() }),
  }),

  defineTool({
    name: 'add_crowdsec_decision',
    title: 'Ban an address',
    description:
      'Bans an IP or CIDR range in CrowdSec for every checked service (403). duration one of 1h, 4h, 24h, 168h, 720h, 8760h. ' +
      'Takes effect within about 10 seconds.',
    input: {
      value: z.string().describe('IP or CIDR range, e.g. "203.0.113.7" or "198.51.100.0/24".'),
      duration: z.enum(BAN_DURATIONS).optional().describe('Default 4h.'),
      reason: z.string().max(120).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run: (args, ctx) => addDecision(args, auditActor(ctx.actor)),
  }),

  defineTool({
    name: 'remove_crowdsec_decision',
    title: 'Lift a ban',
    description: 'Lifts one ban by id (from list_crowdsec_decisions) or all bans of a value (IP or range).',
    input: {
      id: z.number().int().optional(),
      value: z.string().optional().describe('IP or CIDR range; removes every ban for it.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (args, ctx) => removeDecision(args, auditActor(ctx.actor)),
  }),

  defineTool({
    name: 'list_crowdsec_allowlist',
    title: 'List CrowdSec allowlist',
    description: 'Addresses HAPM allows: CrowdSec never bans them, and HAProxy does not send their requests to the WAF.',
    input: {},
    annotations: READ_ONLY,
    run: async () => ({ entries: await listAllowlist() }),
  }),

  defineTool({
    name: 'add_crowdsec_allowlist',
    title: 'Allow an address',
    description:
      'Adds an IP or CIDR range to the allowlist. Existing bans for it are lifted. duration empty = permanent, or 24h, 168h, 720h. ' +
      'Side effect: HAProxy reloads to pick up the list.',
    input: {
      value: z.string(),
      description: z.string().max(120).optional(),
      duration: z.enum(ALLOW_DURATIONS).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: (args, ctx) => addAllowlist(args, auditActor(ctx.actor)),
  }),

  defineTool({
    name: 'remove_crowdsec_allowlist',
    title: 'Remove an allowed address',
    description: 'Removes an IP or CIDR range from the allowlist; CrowdSec checks it again. Side effect: HAProxy reloads.',
    input: { value: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (args, ctx) => removeAllowlist(args, auditActor(ctx.actor)),
  }),

  defineTool({
    name: 'list_crowdsec_alerts',
    title: 'List CrowdSec alerts',
    description:
      'What CrowdSec detected: kind waf (blocked request), scenario (address detected in the HAProxy log, usually banned) or manual. ' +
      'Each alert has targetId (service id) where it can be assigned. Filter by service id.',
    input: {
      window: z.enum(['24h', '7d', '30d']).optional().describe('Default 24h.'),
      service: z.string().optional().describe('Service id (list_services).'),
    },
    annotations: READ_ONLY,
    run: (args) => listAlerts({ window: args.window, service: args.service, limit: 200 }),
  }),

  defineTool({
    name: 'clear_crowdsec',
    title: 'Clear CrowdSec alerts and automatic bans',
    description:
      'Fresh start: removes every alert and lifts the bans CrowdSec imposed from them, so statistics start at zero. ' +
      'Manual bans, the allowlist, rules and the community blocklist stay. Takes up to a minute: HAPM waits until the bouncer ' +
      'has fetched the lifted bans. Returns alerts (removed), lifted (bans), kept (manual bans) and lost (manual bans that could not be set again).',
    input: {},
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (_args, ctx) => clearCrowdsec(auditActor(ctx.actor)),
  }),

  defineTool({
    name: 'get_crowdsec_stats',
    title: 'CrowdSec statistics',
    description: 'Alerts per hour (per day beyond 3 days) by kind, top scenarios, countries, sources, services and paths, active bans.',
    input: { window: z.enum(['24h', '7d', '30d']).optional() },
    annotations: READ_ONLY,
    run: (args) => crowdsecStatistics(args.window),
  }),

  defineTool({
    name: 'get_crowdsec_rules',
    title: 'CrowdSec rules',
    description:
      'The OWASP CRS mode (off or block), the base collections, rules per application (apps: exclusions against known false bans, ' +
      'for WordPress also virtual patches; services = the services that name this app in their "app" field, the rules are ' +
      'installed while at least one does; partial = only some parts installed) and further optional collections.',
    input: {},
    annotations: READ_ONLY,
    run: () => crowdsecRules(),
  }),

  defineTool({
    name: 'update_crowdsec_rules',
    title: 'Change CrowdSec rules',
    description:
      'One change per call: {"crs":"off"|"block"} for the OWASP Core Rule Set (block rejects every request with a hit with 403, harmless ones too: check the alerts afterwards), ' +
      '{"name":"<collection>","installed":true|false} for an optional collection, or {"upgrade":true} to update all rules from the hub.',
    input: {
      crs: z.enum(CRS_MODES as unknown as [string, ...string[]]).optional(),
      name: z.string().optional(),
      installed: z.boolean().optional(),
      upgrade: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: async (args, ctx) => {
      await assertRulesWritable(args);
      return changeRules(args, auditActor(ctx.actor));
    },
  }),

  /* ── Sicherung ── */

  defineTool({
    name: 'get_backup',
    title: 'Backup overview',
    description:
      'Backup settings (enabled, hostPath = folder on the host, time HH:MM, keep = how many archives stay, ' +
      'encrypted = archives are encrypted with a backup passphrase and end in .tar.gz.gpg), whether backups are available ' +
      '(HAPM must run in a container), whether one is running, the recent runs (without steps) and the archives in the folder after the last run. ' +
      'An archive contains the database and the HAProxy files. The backup passphrase is a secret: it can only be set, changed or removed ' +
      'in the web interface and is never returned. passphraseUnreadable = true means it has to be entered there again before backups work.',
    input: {},
    annotations: READ_ONLY,
    run: async () => {
      const overview = await backupOverview();
      return { ...overview, runs: overview.runs.map(runSummary) };
    },
  }),

  defineTool({
    name: 'update_backup_settings',
    title: 'Update backup settings',
    description:
      'Partial update of the backup settings: only the fields you send change. ' +
      'hostPath is an absolute folder on the host (not inside the container); null removes it, which stops backups. ' +
      'Lowering keep means the next backup deletes the oldest archives beyond that number. Returns the backup overview.',
    input: {
      enabled: z.boolean().optional().describe('Daily backup on or off.'),
      hostPath: z.string().nullable().optional().describe('Absolute folder on the host, e.g. "/srv/backups/hapm". null: no folder.'),
      time: z.string().optional().describe('Time of the daily backup, HH:MM (24 h, server time).'),
      keep: z.number().int().optional().describe('How many archives to keep, 1 to 365.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (args, ctx) => changeBackupSettings(args, auditActor(ctx.actor)),
  }),

  defineTool({
    name: 'start_backup',
    title: 'Start backup',
    description:
      'Writes a backup archive into the configured folder now (database and HAProxy files). Needs hostPath (get_backup). ' +
      'Old archives beyond keep are removed afterwards, as with the daily backup. Returns { runId }; poll get_backup_run.',
    input: {},
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: async (_args, ctx) => ({
      ...(await startBackupRun(auditActor(ctx.actor))),
      next: 'Call get_backup_run with this runId and waitSeconds=50 until status is no longer "running".',
    }),
  }),

  defineTool({
    name: 'get_backup_run',
    title: 'Get backup run',
    description:
      'Status of a backup run: status, fileName, sizeBytes, steps and a text log. ' +
      `With waitSeconds (max ${MAX_WAIT_SECONDS}) the call waits until the run is finished or the time is up.`,
    input: {
      runId: z.string().describe('runId returned by start_backup.'),
      waitSeconds: waitSecondsInput,
    },
    annotations: READ_ONLY,
    run: (args, ctx) => waitFor(() => getBackupRun(args.runId, ctx.t), args.waitSeconds ?? 0),
  }),

  /* ── Abgleich zwischen Knoten ── */

  defineTool({
    name: 'get_sync',
    title: 'Node sync overview',
    description:
      'High availability: the role of this node (single, primary or replica). On a primary: the replicas with their state ' +
      '(reachable, inSync, lastSyncAt, lastError, warnings). On a replica: the primary it is bound to and when the last state arrived. ' +
      'Plus the recent sync runs (without steps). A primary pushes haproxy.cfg, certificates and error pages to its replicas after every change. ' +
      'On a replica every tool that changes targets, certificates or proxy settings is refused: change them on the primary.',
    input: {},
    annotations: READ_ONLY,
    run: async () => {
      const overview = await syncOverview();
      return { ...overview, runs: overview.runs.map(runSummary) };
    },
  }),

  defineTool({
    name: 'start_sync',
    title: 'Sync replicas now',
    description:
      'Pushes the current state of this primary node to every replica now, even if a replica already carries it. ' +
      'Only works on a primary with at least one replica (see get_sync). Role, pairing key and replicas are managed in the web interface only. ' +
      'Returns { runId }; poll get_sync_run.',
    input: {},
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (_args, ctx) => ({
      ...(await startSyncRun(auditActor(ctx.actor))),
      next: 'Call get_sync_run with this runId and waitSeconds=50 until status is no longer "running".',
    }),
  }),

  defineTool({
    name: 'get_sync_run',
    title: 'Get sync run',
    description:
      'Status of a sync run: direction (send or receive), peers, status, steps and a text log. ' +
      `With waitSeconds (max ${MAX_WAIT_SECONDS}) the call waits until the run is finished or the time is up.`,
    input: {
      runId: z.string().describe('runId returned by start_sync, or the $id of a run from get_sync.'),
      waitSeconds: waitSecondsInput,
    },
    annotations: READ_ONLY,
    run: (args, ctx) => waitFor(() => getSyncRun(args.runId, ctx.t), args.waitSeconds ?? 0),
  }),

  /* ── Einstellungen ── */

  defineTool({
    name: 'get_settings',
    title: 'HAPM settings',
    description:
      'Settings of HAPM itself: publicUrl (the HAPM address), exposure ("internal": every certificate via DNS-01, "public": HTTP-01), ' +
      'certificateSource ("acme" or "upload"), acmeDirectory (null: Let\'s Encrypt), acmeHttpReachable, acmeEmail, dnsWait, ' +
      'automatic HAProxy updates, the SMTP account (smtpPassSet instead of the password), notification recipients and events, mailLocale. ' +
      'notifications tells whether mail is configured and how the last delivery went.',
    input: {},
    annotations: READ_ONLY,
    run: () => settingsOverview(),
  }),

  defineTool({
    name: 'update_settings',
    title: 'Update HAPM settings',
    description:
      'Partial update of the HAPM settings: only the fields you send change. ' +
      'Not possible here: the HAPM address (moving it is a guided process in the web interface), the SMTP server and its password ' +
      '(whoever redirects the mail server receives password reset links), and the certificate source ' +
      '(use update_certificate_settings). Changing exposure changes how future certificates are requested, existing ones stay. ' +
      'A new acmeEmail is registered with acme.sh; the result is in "acme". Example: {"notifyRecipients":["ops@example.com"]}.',
    input: {
      acmeEmail: z.string().nullable().optional().describe('Contact address for the ACME account (Let\'s Encrypt).'),
      exposure: z.enum(EXPOSURES as [string, ...string[]]).optional().describe('"internal" or "public".'),
      autoUpdate: z
        .array(z.enum(UPDATE_COMPONENTS as [string, ...string[]]))
        .optional()
        .describe('Components updated automatically once a day at autoUpdateTime, e.g. ["haproxy","acme","crowdsec","crowdsec-bouncer"]. [] turns it off.'),
      autoUpdateHaproxy: z.boolean().optional().describe('Older switch: adds HAProxy to autoUpdate or removes it.'),
      autoUpdateTime: z.string().optional().describe('Time for automatic updates, HH:MM.'),
      mailFrom: z.string().nullable().optional().describe('Sender address of notification mails.'),
      notifyRecipients: z.array(z.string()).optional().describe('Replace the list of recipients (max 20 addresses).'),
      notifyEvents: z
        .object(Object.fromEntries(NOTIFICATION_EVENT_TYPES.map((type) => [type, z.boolean().optional()])))
        .optional()
        .describe('Switch single notification events on or off; events not listed keep their state.'),
      mailLocale: z.enum(LOCALES as [string, ...string[]]).optional().describe('Language of notification mails.'),
      dnsWait: z
        .number()
        .int()
        .optional()
        .describe('Seconds acme.sh waits after setting the DNS-01 record when the hook is dns_nsupdate or dns_infoblox (5 to 900).'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    run: (args, ctx) => changeSettings(readServiceSettingsInput(args), auditActor(ctx.actor)),
  }),

  defineTool({
    name: 'update_certificate_settings',
    title: 'Update certificate source',
    description:
      'Where certificates come from: source "acme" (HAPM requests them) or "upload" (only uploaded certificates, HAPM never requests one). ' +
      'acmeDirectory: URL of an own ACME server, empty or null for Let\'s Encrypt; a new server gets an account registered first, ' +
      'and nothing is saved if that fails. httpReachable: the ACME server reaches HAPM on port 80, so HTTP-01 works even for an internal installation. ' +
      'External Account Binding keys are not accepted here (they are secrets): set those in the web interface.',
    input: {
      source: z.enum(CERTIFICATE_SOURCES as [string, ...string[]]).describe('"acme" or "upload".'),
      acmeDirectory: z
        .string()
        .nullable()
        .optional()
        .describe('ACME directory URL, e.g. "https://acme.internal/directory". Omit or null: Let\'s Encrypt.'),
      httpReachable: z.boolean().optional().describe('Only with an own acmeDirectory. Default false.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    run: (args, ctx) => changeCertificateSettings(args, auditActor(ctx.actor), { allowEab: false }),
  }),

  defineTool({
    name: 'send_test_mail',
    title: 'Send test mail',
    description:
      'Sends a test mail through the stored SMTP account to one address. Limited to 5 per 10 minutes. ' +
      'A rejection by the mail server is not an error of this tool: the result has sent=false and the server message.',
    input: { to: z.string().describe('Recipient address.') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: (args, ctx) => sendTestMailAs(args.to, auditActor(ctx.actor), null),
  }),

  defineTool({
    name: 'check_address',
    title: 'Check HAPM address',
    description:
      'Checks whether a domain could become the address of HAPM: where it resolves, which DNS zone it is in, whether a certificate covers it ' +
      'and how one would be issued. Read-only. The move itself is only possible in the web interface: it changes the address this MCP server ' +
      'is reached through and deletes all passkeys.',
    input: { domain: z.string().describe('Domain, e.g. "hapm.example.com".') },
    annotations: { ...READ_ONLY, openWorldHint: true },
    run: (args) => checkAddressMove(args.domain),
  }),

  /* ── HAProxy, Zertifikate, Grundkonfiguration, Fehlerseiten ── */

  defineTool({
    name: 'get_haproxy_container',
    title: 'HAProxy container',
    description:
      'State of the HAProxy container (running, restarts, image, version). logs=true adds its last 200 lines of output ' +
      '(startup errors, configuration warnings), not the access log; that is get_haproxy_log.',
    input: { logs: z.boolean().optional().describe('Include the last 200 lines of container output. Default false.') },
    annotations: READ_ONLY,
    run: (args) => haproxyContainer({ logs: args.logs === true }),
  }),

  defineTool({
    name: 'restart_haproxy',
    title: 'Restart HAProxy',
    description:
      'Restarts the HAProxy container (also starts it if it is stopped) and returns its state two seconds later. ' +
      'All open connections drop. Not needed after a configuration change: every write tool reloads HAProxy itself. ' +
      'Use it when HAProxy is down or hangs.',
    input: {},
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run: (_args, ctx) => restartHaproxy(auditActor(ctx.actor)),
  }),

  defineTool({
    name: 'get_haproxy_log',
    title: 'HAProxy log',
    description:
      'The last lines of the HAProxy log (requests and system messages), parsed. ' +
      'Without filter and query: exactly the last "lines" lines. With a filter or query: a fixed window of recent lines is searched ' +
      '(window, scanned and matched say how much). exists=false or a follower that is not connected means there is no log, not "no traffic".',
    input: {
      lines: z.number().int().min(1).max(2000).optional().describe('How many entries to return, up to 2000. Default 200.'),
      filter: z.enum(LOG_FILTERS).optional().describe('all, requests, 2xx, 3xx, 4xx, 5xx, system or problems. Default all.'),
      query: z.string().optional().describe('Case-insensitive text search, e.g. a domain or an IP.'),
    },
    annotations: READ_ONLY,
    run: (args) => readHaproxyLog({ lines: args.lines ?? null, filter: args.filter ?? null, q: args.query ?? null }),
  }),

  defineTool({
    name: 'list_audit_log',
    title: 'Audit log',
    description:
      'The HAPM audit log: who did what and when (sign-ins, changes to targets, certificates, DNS, backups, updates, settings, API keys). ' +
      'Each entry: id, timestamp (UTC), action (e.g. "login_failed"), area, actorType (user, service = API key, system), actor, resource, details, ip, outcome. ' +
      'Default: newest first; pass the returned cursor as "before" for older entries. ' +
      'To collect everything without gaps, pass "after" (or order "asc"): entries then come oldest first and end about two seconds before now; ' +
      'pass the returned cursor as "after" on the next call. more=true means there is another page. ' +
      'Details are stored in German. Retention and forwarding to a SIEM can only be changed in the HAPM web interface.',
    input: {
      from: z.string().optional().describe('Only entries at or after this time, ISO 8601, e.g. "2026-11-26T00:00:00Z".'),
      to: z.string().optional().describe('Only entries at or before this time, ISO 8601.'),
      actor: z.enum(AUDIT_ACTOR_TYPES).optional().describe('user, service (API key) or system (scheduler).'),
      area: z.enum(AUDIT_AREAS).optional().describe('Only actions of one area.'),
      query: z.string().optional().describe('Case-insensitive text search in actor, action, resource, details and IP.'),
      limit: z.number().int().min(1).max(AUDIT_PAGE_MAX).optional().describe('Entries per call, up to 1000. Default 50.'),
      before: z.string().optional().describe('Cursor of a previous call: entries older than it (newest first).'),
      after: z.string().optional().describe('Cursor of a previous call: entries newer than it (oldest first).'),
      order: z.enum(['asc', 'desc']).optional().describe('asc: oldest first. desc: newest first (default).'),
    },
    annotations: READ_ONLY,
    run: (args) =>
      readAuditLog(
        readAuditQuery({
          from: args.from,
          to: args.to,
          actor: args.actor,
          area: args.area,
          q: args.query,
          limit: args.limit,
          before: args.before,
          after: args.after,
          order: args.order,
        })
      ),
  }),

  defineTool({
    name: 'delete_certificate',
    title: 'Delete certificate',
    description:
      'Removes a certificate managed by acme.sh (by its mainDomain from list_certificates): acme.sh forgets it, a deployed PEM file is deleted ' +
      'and HAProxy reloads. Refused while a target still uses it or one of its domains is covered by it. ' +
      'Meant for leftovers: usedBy empty, or a request that was never issued. Uploaded certificates can only be removed in the web interface.',
    input: { mainDomain: z.string().describe('Main domain of the certificate, e.g. "*.example.com" or "old.example.com".') },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run: (args, ctx) => removeCertificate({ domain: args.mainDomain }, auditActor(ctx.actor), { allowUploaded: false }),
  }),

  defineTool({
    name: 'reissue_certificate',
    title: 'Retry certificate request',
    description:
      'Requests a certificate again that acme.sh knows but that was never issued (createdAt null in list_certificates), ' +
      'typically a wildcard whose DNS challenge failed during setup. Only with its own domains; issued certificates are renewed by acme.sh itself (409). ' +
      'Returns { runId }; poll get_run, issuing can take up to 5 minutes.',
    input: {
      mainDomain: z.string().describe('Main domain of the pending request.'),
      dnsHook: z.string().optional().describe('acme.sh DNS hook (from get_proxy dnsHooks). Only needed when more than one is set up.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: async (args, ctx) => started(await reissueCertificate(args, ctx.actor)),
  }),

  defineTool({
    name: 'list_certificate_authorities',
    title: 'List certificate authorities',
    description:
      'Certificate authorities stored for checking upstream certificates (backendTls "ca:<name>"): name, file, their certificates ' +
      '(subject, issuer, notAfter, SHA-256 fingerprint), daysLeft until the earliest expiry and usedBy (target IDs). ' +
      'These are trust anchors for upstreams with a certificate from an internal CA, not certificates served to visitors (see list_certificates).',
    input: {},
    annotations: READ_ONLY,
    run: (_args, ctx) => listCertificateAuthorities(ctx.t),
  }),

  defineTool({
    name: 'upload_certificate_authority',
    title: 'Store certificate authority',
    description:
      'Stores the certificate of a certificate authority (PEM, one certificate or a bundle of root and intermediates) under a name, ' +
      'so targets can check their upstream certificate against it with backendTls "ca:<name>". Only certificates: a private key is rejected. ' +
      'Rejected as well: expired certificates and a server certificate that is neither a CA nor self-signed. ' +
      'Without replace an existing name is not overwritten (409). With replace=true the file of an existing authority is exchanged; ' +
      'if a target uses it, HAProxy is checked and reloaded (reloaded=true) and upstreams whose certificate the new file no longer confirms answer 503. ' +
      'Synchronous, no run. Returns name, certificates, notAfter, reloaded, usedBy, warnings.',
    input: {
      name: z.string().describe('Lowercase letters, digits and hyphens, up to 40 characters, e.g. "intern-root". It becomes the file name and stays.'),
      certificate: z.string().describe('PEM text starting with -----BEGIN CERTIFICATE-----. Several certificates one after another are a bundle.'),
      replace: z.boolean().optional().describe('true: exchange the file of an authority that already exists under this name.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run: (args, ctx) => saveCertificateAuthority(args, auditActor(ctx.actor), ctx.t),
  }),

  defineTool({
    name: 'delete_certificate_authority',
    title: 'Remove certificate authority',
    description:
      'Removes a stored certificate authority by name. Refused (409) while a target still checks against it (usedBy in list_certificate_authorities) ' +
      'or haproxy.cfg mentions its file anywhere: switch those targets to another backendTls first.',
    input: { name: z.string().describe('Name from list_certificate_authorities.') },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run: (args, ctx) => removeCertificateAuthority(args.name, auditActor(ctx.actor)),
  }),

  defineTool({
    name: 'get_base_config_diff',
    title: 'Base configuration check',
    description:
      'Compares haproxy.cfg with the base configuration HAPM would write today (global and defaults sections, TLS, headers, timeouts). ' +
      'Each difference has an id, a section, missing or changed, and the lines. Nothing is changed. Apply selected ones with apply_base_config.',
    input: {},
    annotations: READ_ONLY,
    run: async (_args, ctx) => (await readBaseConfigRows(ctx.t, ctx.locale))[0] ?? null,
  }),

  defineTool({
    name: 'apply_base_config',
    title: 'Apply base configuration',
    description:
      'Applies selected differences from get_base_config_diff by their id. Runs synchronously: rewrites haproxy.cfg, haproxy -c, reload. ' +
      'If an id no longer exists (the file changed meanwhile), nothing is written. Returns the steps and the new diff.',
    input: { ids: z.array(z.string()).min(1).max(200).describe('ids from get_base_config_diff.') },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (args, ctx) => applyBaseConfig({ ids: args.ids }, auditActor(ctx.actor)),
  }),

  defineTool({
    name: 'get_error_pages',
    title: 'Error pages',
    description:
      'The error pages HAProxy serves (errorfile entries in haproxy.cfg) and the password prompt pages, each with its state compared ' +
      'to the design stored in HAPM. The design itself is edited only in the web interface.',
    input: {},
    annotations: READ_ONLY,
    run: async (_args, ctx) => (await readErrorPageRows(ctx.t, ctx.locale))[0] ?? null,
  }),

  defineTool({
    name: 'redeploy_error_pages',
    title: 'Redeploy error pages',
    description:
      'Rewrites every error page and password prompt page in the stored design, then haproxy -c and reload. ' +
      'Pages edited by hand on the server are overwritten. Runs synchronously and returns the steps.',
    input: {},
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (_args, ctx) => redeployErrorPages({}, auditActor(ctx.actor)),
  }),

  /* ── GeoIP ── */

  defineTool({
    name: 'get_geoip',
    title: 'GeoIP table',
    description:
      'The country table used for country statistics and blockedCountries: version, origin (bundled, fetched or uploaded), ' +
      'number of IPv4 and IPv6 ranges, autoRefresh and the last fetch attempt.',
    input: {},
    annotations: READ_ONLY,
    run: () => geoipOverview(),
  }),

  defineTool({
    name: 'refresh_geoip',
    title: 'Refresh GeoIP table',
    description:
      'Fetches the current country table from db-ip.com now and waits for it (seconds). changed=false: it was already current. ' +
      'Fails with 502 when db-ip.com does not deliver; the existing table stays.',
    input: {},
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: (_args, ctx) => refreshGeoipNow(auditActor(ctx.actor)),
  }),

  defineTool({
    name: 'set_geoip_auto_refresh',
    title: 'GeoIP automatic refresh',
    description: 'Turns the daily automatic refresh of the country table on or off. Returns the GeoIP overview.',
    input: { autoRefresh: z.boolean().describe('true: fetch once a day.') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (args, ctx) => changeGeoipAutoRefresh(args.autoRefresh, auditActor(ctx.actor)),
  }),
];
