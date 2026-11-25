/**
 * Die Werkzeuge des MCP-Servers: Name, Beschreibung, Schema, Hinweise und die
 * Funktion, die sie aufrufen.
 *
 * ── Was hier steht und was nicht ──
 *
 * Kein Werkzeug hat eigene Logik. Jedes ruft eine Funktion, die auch eine
 * Route ruft: `lib/haproxy/api-actions.ts` für alles, was die Reverse-Proxy-API
 * kann, dazu `systemOverview`, `readStatsOverview` und `checkZones` für die
 * Seiten Übersicht, Statistik und DNS. Damit gelten dieselben Prüfungen,
 * dieselbe Vorabprüfung und derselbe Schutz des Ziels der Oberfläche, ohne
 * dass sie hier ein zweites Mal stehen.
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
import { BACKEND_TLS, HAPROXY_BALANCE } from '../haproxy/config';
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
  .enum(BACKEND_TLS)
  .optional()
  .describe(
    'How HAProxy talks to the upstream. Omit or "off": plain HTTP. "insecure": HTTPS without checking the certificate ' +
      '(self-signed, e.g. Proxmox on 8006, TrueNAS). "verify": HTTPS, certificate checked against the system CAs ' +
      '(needs HAProxy 2.6+). Both HTTPS modes send the request Host as SNI.'
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
    'Own setting per rule, not inherited from the target: off, insecure or verify (see backendTls of the target).'
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
  healthcheck: z
    .boolean()
    .optional()
    .describe('HTTP health check against domains[0]. Default false. Ignored when domains[0] is a wildcard or redirect is set.'),
  backendTls,
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
async function waitForRun(runId: string, waitSeconds: number, t: Translate): Promise<RunView> {
  const until = Date.now() + Math.min(Math.max(waitSeconds, 0), MAX_WAIT_SECONDS) * 1000;
  let run = await getRun(runId, t);
  while (run.status === 'running' && Date.now() + POLL_MS <= until) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    run = await getRun(runId, t);
  }
  return run;
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
      '(servers, routes, headers, tunnel, healthcheck, backendTls, lockedDomains). Always call get_service first, modify its result, and send all fields. ' +
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
      'lockedServices are targets currently restricted to the admin IPs; the list cannot be emptied while one exists.',
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
      'Side effects: rewrites haproxy.cfg and reloads HAProxy. Returns { runId }; poll get_run. Example: {"addAdminIps":["203.0.113.7"]}.',
    input: {
      addAdminIps: z.array(z.string()).optional().describe('IPs or CIDR ranges to add.'),
      removeAdminIps: z.array(z.string()).optional().describe('IPs or CIDR ranges to remove.'),
      adminIps: z.array(z.string()).optional().describe('Replace the whole admin IP list.'),
      httpsLines: z
        .array(z.string())
        .optional()
        .describe('Replace the global HTTPS lines, e.g. ["http-response set-header Strict-Transport-Security max-age=31536000"].'),
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
      'usedBy empty means issued by hand or left over from a deleted target. Read-only: certificates come and go with their targets.',
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
];
