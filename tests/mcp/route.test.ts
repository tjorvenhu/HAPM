import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';

/**
 * Ein echter JSON-RPC-Ablauf gegen den Route-Handler von `/api/mcp`:
 * initialize, notifications/initialized, tools/list, tools/call. Ohne Server,
 * ohne Datenbank und ohne HAProxy: Anmeldung und Bibliothek sind ersetzt. Was
 * hier geprüft wird, ist das Stück dazwischen, also Transport, Anmeldung, die
 * Abbildung Werkzeug → Funktion und die Form der Antworten.
 */

const auth = vi.hoisted(() => ({ fail: false }));

vi.mock('@/lib/service-auth', async () => {
  const { ApiError: Err } = await import('@/lib/api');
  return {
    requireServiceToken: vi.fn(async () => {
      if (auth.fail) throw new Err('Service-Token ungültig.', 401);
      return { id: 'tok1', name: 'deploy-skript' };
    }),
  };
});

const actions = vi.hoisted(() => ({
  listProxies: vi.fn(),
  listScopes: vi.fn(),
  changeScope: vi.fn(),
  listServices: vi.fn(),
  getService: vi.fn(),
  createServiceRun: vi.fn(),
  updateServiceRun: vi.fn(),
  deleteServiceRun: vi.fn(),
  listStreams: vi.fn(),
  checkPort: vi.fn(),
  getStream: vi.fn(),
  createStreamRun: vi.fn(),
  updateStreamRun: vi.fn(),
  deleteStreamRun: vi.fn(),
  listRuns: vi.fn(),
  getRun: vi.fn(),
  getProxySettings: vi.fn(),
  patchProxySettings: vi.fn(),
  listCertificates: vi.fn(),
}));

vi.mock('@/lib/haproxy/api-actions', () => ({
  ...actions,
  RUN_STATUSES: ['running', 'success', 'warning', 'error', 'cancelled'],
  RUN_ACTIONS: ['create', 'update', 'delete', 'settings', 'scope-add', 'scope-remove', 'stream-create', 'stream-update', 'stream-delete', 'certificate', 'import'],
}));
vi.mock('@/lib/system/overview', () => ({ systemOverview: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/lib/haproxy/stats-overview', () => ({ readStatsOverview: vi.fn() }));
vi.mock('@/lib/dns/zone-check', () => ({ checkZones: vi.fn(async () => []) }));

const { POST, GET, DELETE } = await import('@/app/api/mcp/route');

let nextId = 1;

function rpc(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://hapm.example.test/api/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer hapm_test',
      'x-forwarded-for': '203.0.113.9',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function call(method: string, params?: unknown, headers?: Record<string, string>) {
  const res = await POST(rpc({ jsonrpc: '2.0', id: nextId++, method, params }, headers));
  expect(res.status).toBe(200);
  return (await res.json()) as { result?: Record<string, unknown>; error?: { code: number; message: string } };
}

async function callTool(name: string, args: Record<string, unknown> = {}, headers?: Record<string, string>) {
  const body = await call('tools/call', { name, arguments: args }, headers);
  const result = body.result as { isError?: boolean; content: { type: string; text: string }[] };
  return { ...result, text: result.content[0]?.text ?? '' };
}

beforeEach(() => {
  auth.fail = false;
  for (const fn of Object.values(actions)) fn.mockReset();
});

describe('POST /api/mcp', () => {
  it('lehnt ohne gültiges Token mit 401 und einer Bearer-Aufforderung ab', async () => {
    auth.fail = true;
    const res = await POST(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
  });

  it('beantwortet initialize mit Name, Version und Werkzeugen, ohne Sitzung', async () => {
    const res = await POST(
      rpc({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'vitest', version: '1.0.0' },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    // Zustandslos: kein Mcp-Session-Id, den ein Client zurückschicken müsste.
    expect(res.headers.get('mcp-session-id')).toBeNull();

    const body = (await res.json()) as {
      result: {
        protocolVersion: string;
        serverInfo: { name: string };
        capabilities: { tools?: unknown };
        instructions: string;
      };
    };
    expect(body.result.protocolVersion).toBe('2025-06-18');
    expect(body.result.serverInfo.name).toBe('hapm');
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.instructions).toContain('get_run');
  });

  it('nimmt notifications/initialized mit 202 an', async () => {
    const res = await POST(rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    expect(res.status).toBe(202);
  });

  it('beantwortet ping', async () => {
    const body = await call('ping');
    expect(body.result).toEqual({});
  });

  it('listet die Werkzeuge mit Schema und Hinweisen', async () => {
    const body = await call('tools/list');
    const tools = body.result!.tools as {
      name: string;
      description: string;
      inputSchema: { type: string; properties?: Record<string, unknown>; required?: string[] };
      annotations: { readOnlyHint?: boolean; destructiveHint?: boolean };
    }[];

    const names = tools.map((tool) => tool.name);
    expect(names).toContain('get_proxy');
    expect(names).toContain('create_service');
    expect(names).toContain('get_run');

    const create = tools.find((tool) => tool.name === 'create_service')!;
    expect(create.inputSchema.type).toBe('object');
    expect(create.inputSchema.required).toEqual(expect.arrayContaining(['scope', 'domains']));
    expect(create.annotations.readOnlyHint).toBe(false);

    const del = tools.find((tool) => tool.name === 'delete_service')!;
    expect(del.annotations.destructiveHint).toBe(true);

    const list = tools.find((tool) => tool.name === 'list_services')!;
    expect(list.annotations.readOnlyHint).toBe(true);

    // Die Werkzeuge außerhalb des Reverse-Proxys kommen als JSON Schema mit an.
    const update = tools.find((tool) => tool.name === 'start_update')!;
    expect(update.inputSchema.properties?.component).toMatchObject({ enum: ['haproxy', 'hapm', 'acme', 'crowdsec', 'crowdsec-bouncer'] });
    expect(update.annotations.destructiveHint).toBe(true);

    const settings = tools.find((tool) => tool.name === 'update_settings')!;
    expect(Object.keys(settings.inputSchema.properties ?? {})).not.toContain('publicUrl');
    expect(settings.inputSchema.properties?.notifyEvents).toBeDefined();

    expect(names).toEqual(expect.arrayContaining(['get_update_run', 'get_backup', 'get_settings', 'get_haproxy_log']));
  });

  it('ruft für list_services die Funktion der API und gibt JSON zurück', async () => {
    actions.listServices.mockResolvedValue({ services: [{ id: 'shop_example_com' }], unreachable: [] });

    const result = await callTool('list_services', { scope: 'KUNDEN' });

    expect(result.isError).toBeFalsy();
    expect(actions.listServices).toHaveBeenCalledWith({ scope: 'KUNDEN', domain: undefined }, expect.any(Function));
    expect(JSON.parse(result.text)).toEqual({ services: [{ id: 'shop_example_com' }], unreachable: [] });
  });

  it('schreibt mit dem Namen des Tokens als Actor und nennt den nächsten Schritt', async () => {
    actions.createServiceRun.mockResolvedValue({ runId: 'run1', serverId: 'local', serviceId: 'shop_example_com' });

    const result = await callTool('create_service', {
      scope: 'KUNDEN',
      domains: ['shop.example.com'],
      servers: [{ target: '10.0.0.12:3000' }],
      healthcheck: true,
      dnsDomains: 'auto',
    });

    expect(result.isError).toBeFalsy();
    const [body, actor] = actions.createServiceRun.mock.calls[0];
    expect(body).toMatchObject({ scope: 'KUNDEN', domains: ['shop.example.com'], dnsDomains: 'auto' });
    expect(actor).toEqual({ userId: 'service:tok1', email: 'deploy-skript', ip: '203.0.113.9' });

    const parsed = JSON.parse(result.text);
    expect(parsed.runId).toBe('run1');
    expect(parsed.next).toContain('get_run');
  });

  it('bildet update_service auf den vollständigen Rumpf ab: newId wird id, ein fehlendes passwordLock bleibt fehlend', async () => {
    actions.updateServiceRun.mockResolvedValue({ runId: 'run2', serverId: 'local', serviceId: 'shop' });

    await callTool('update_service', {
      id: 'shop',
      scope: 'KUNDEN',
      domains: ['shop.example.com'],
      servers: [{ target: '10.0.0.12:3000' }],
    });

    const [id, body] = actions.updateServiceRun.mock.calls[0];
    expect(id).toBe('shop');
    expect(body.id).toBe('');
    // Fehlt das Feld, bleibt die Art der Sperre (`INHERIT_LOCK`). Ein `null`
    // hieße „auf Admin-IPs umstellen".
    expect('passwordLock' in body).toBe(false);
    expect('newId' in body).toBe(false);

    await callTool('update_service', {
      id: 'shop',
      newId: 'laden',
      scope: 'KUNDEN',
      domains: ['shop.example.com'],
      passwordLock: null,
    });
    const [, renamed] = actions.updateServiceRun.mock.calls[1];
    expect(renamed.id).toBe('laden');
    expect(renamed.passwordLock).toBeNull();
  });

  it('gibt eine Ablehnung der Bibliothek als Ergebnis mit isError zurück, standardmäßig englisch', async () => {
    actions.getRun.mockRejectedValue(new ApiError(msg('Reverse-Proxy-Vorgang nicht gefunden.'), 404));

    const result = await callTool('get_run', { runId: 'nope' });

    expect(result.isError).toBe(true);
    expect(result.text).toBe('Error 404: Reverse proxy task not found.');
  });

  it('antwortet deutsch, wenn der Client Deutsch verlangt', async () => {
    actions.getRun.mockRejectedValue(new ApiError(msg('Reverse-Proxy-Vorgang nicht gefunden.'), 404));

    const result = await callTool('get_run', { runId: 'nope' }, { 'accept-language': 'de-DE,de;q=0.9' });

    expect(result.text).toBe('Error 404: Reverse-Proxy-Vorgang nicht gefunden.');
  });

  it('lehnt Argumente in falscher Form ab, ohne die Bibliothek zu rufen', async () => {
    const result = await callTool('create_service', { scope: 'KUNDEN', domains: 'shop.example.com' });

    expect(result.isError).toBe(true);
    expect(actions.createServiceRun).not.toHaveBeenCalled();
  });

  it('kennt ein unbekanntes Werkzeug nicht', async () => {
    const body = await call('tools/call', { name: 'rm_rf', arguments: {} });
    const failed = body.error ?? (body.result as { isError?: boolean } | undefined);
    expect(failed).toBeTruthy();
    if (body.result) expect((body.result as { isError?: boolean }).isError).toBe(true);
  });
});

describe('GET und DELETE /api/mcp', () => {
  it('antworten mit 405: kein Strom, keine Sitzung', async () => {
    for (const handler of [GET, DELETE]) {
      const res = handler();
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
  });
});
