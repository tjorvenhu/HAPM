import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTranslator } from '@/lib/i18n';

/**
 * Die Werkzeugliste ohne Transport: Namen, Hinweise, Rechte und die
 * Abbildung jedes schreibenden Werkzeugs auf seine Funktion.
 */

const actions = vi.hoisted(() => ({
  listProxies: vi.fn(async () => [{ id: 'local' }]),
  listScopes: vi.fn(),
  changeScope: vi.fn(async () => ({ name: 'kunden', runs: [{ runId: 'r', serverId: 'local', serverName: 'x' }] })),
  listServices: vi.fn(),
  getService: vi.fn(),
  createServiceRun: vi.fn(async () => ({ runId: 'r', serverId: 'local', serviceId: 's' })),
  updateServiceRun: vi.fn(async () => ({ runId: 'r', serverId: 'local', serviceId: 's' })),
  deleteServiceRun: vi.fn(async () => ({ runId: 'r', serverId: 'local', serviceId: 's' })),
  listStreams: vi.fn(),
  checkPort: vi.fn(),
  getStream: vi.fn(),
  createStreamRun: vi.fn(async () => ({ runId: 'r', serverId: 'local', streamId: 'tcp_5432' })),
  updateStreamRun: vi.fn(async () => ({ runId: 'r', serverId: 'local', streamId: 'tcp_5432' })),
  deleteStreamRun: vi.fn(async () => ({ runId: 'r', serverId: 'local', streamId: 'tcp_5432' })),
  listRuns: vi.fn(),
  getRun: vi.fn(),
  getProxySettings: vi.fn(),
  patchProxySettings: vi.fn(async () => ({ runId: 'r', serverId: 'local', adminIps: [] })),
  listCertificates: vi.fn(),
}));

vi.mock('@/lib/haproxy/api-actions', () => ({
  ...actions,
  RUN_STATUSES: ['running', 'success', 'warning', 'error', 'cancelled'],
  RUN_ACTIONS: ['create', 'update', 'delete'],
}));
vi.mock('@/lib/system/overview', () => ({ systemOverview: vi.fn() }));
vi.mock('@/lib/haproxy/stats-overview', () => ({
  readStatsOverview: vi.fn(async () => ({
    hours: 24,
    bucketMinutes: 15,
    series: [{ at: 'x' }],
    samples: 1,
    totals: { requests: 10 },
    services: Array.from({ length: 30 }, (_, i) => ({ scope: `b${i}`, serverId: 'local', serverName: 'x', requests: 30 - i })),
    proxies: [],
  })),
}));
vi.mock('@/lib/dns/zone-check', () => ({ checkZones: vi.fn() }));

const { TOOLS, MAX_WAIT_SECONDS } = await import('@/lib/mcp/tools');

const actor = { userId: 'service:tok1', email: 'deploy-skript', ip: '203.0.113.9' };
const ctx = { actor, locale: 'en' as const, t: createTranslator('en').t };

function tool(name: string) {
  const found = TOOLS.find((entry) => entry.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

/** Die Werkzeuge, die einen Lauf starten. Eine neue Zeile hier ist eine Entscheidung. */
const WRITING = [
  'create_service',
  'update_service',
  'delete_service',
  'create_stream',
  'update_stream',
  'delete_stream',
  'create_scope',
  'delete_scope',
  'update_proxy_settings',
];

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockClear();
});

describe('die Werkzeugliste', () => {
  it('hat eindeutige Namen in snake_case', () => {
    const names = TOOLS.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });

  it('schreibt genau mit den Werkzeugen, die dafür vorgesehen sind', () => {
    expect(TOOLS.filter((entry) => entry.writes).map((entry) => entry.name).sort()).toEqual([...WRITING].sort());
  });

  it.each(TOOLS.map((entry) => [entry.name, entry] as const))('%s trägt stimmige Hinweise', (_name, entry) => {
    expect(entry.annotations.title).toBe(entry.title);
    expect(entry.annotations.readOnlyHint).toBe(!entry.writes);
    if (entry.writes) {
      expect(typeof entry.annotations.destructiveHint).toBe('boolean');
    } else {
      expect(entry.annotations.destructiveHint).toBe(false);
    }
    expect(typeof entry.annotations.openWorldHint).toBe('boolean');
  });

  it.each(TOOLS.map((entry) => [entry.name, entry] as const))(
    '%s hat eine englische Beschreibung ohne Gedankenstrich',
    (_name, entry) => {
      // Ein Sprachmodell liest sie. Englisch, weil die Schemas englisch sind.
      expect(entry.description.length).toBeGreaterThan(40);
      expect(entry.description).not.toMatch(/[äöüÄÖÜß]/);
      expect(entry.description).not.toMatch(/ [–—] /);
    }
  );

  it('nennt bei jedem Löschen und Ersetzen die Nebenwirkung', () => {
    for (const name of ['delete_service', 'delete_stream', 'update_service', 'update_stream', 'delete_scope']) {
      expect(tool(name).annotations.destructiveHint, name).toBe(true);
    }
    expect(tool('create_service').annotations.destructiveHint).toBe(false);
  });
});

describe('Rechte: schreibende Werkzeuge reichen den Actor des Tokens weiter', () => {
  const CALLS: [string, Record<string, unknown>, keyof typeof actions][] = [
    ['create_service', { scope: 'K', domains: ['a.example'] }, 'createServiceRun'],
    ['update_service', { id: 's', scope: 'K', domains: ['a.example'] }, 'updateServiceRun'],
    ['delete_service', { id: 's' }, 'deleteServiceRun'],
    ['create_stream', { scope: 'K', port: 5432, servers: [{ target: '10.0.0.1:5432' }] }, 'createStreamRun'],
    ['update_stream', { id: 'tcp_5432', scope: 'K', port: 5432, servers: [] }, 'updateStreamRun'],
    ['delete_stream', { id: 'tcp_5432' }, 'deleteStreamRun'],
    ['create_scope', { name: 'kunden' }, 'changeScope'],
    ['delete_scope', { name: 'kunden' }, 'changeScope'],
    ['update_proxy_settings', { addAdminIps: ['203.0.113.7'] }, 'patchProxySettings'],
  ];

  it('deckt jedes schreibende Werkzeug ab', () => {
    expect(CALLS.map(([name]) => name).sort()).toEqual([...WRITING].sort());
  });

  it.each(CALLS)('%s', async (name, args, fn) => {
    const result = (await tool(name).run(args, ctx)) as { next?: string };
    const calls = actions[fn].mock.calls as unknown[][];
    expect(calls).toHaveLength(1);
    expect(calls[0][calls[0].length - 1]).toBe(actor);
    expect(result.next).toContain('get_run');
  });

  it('delete_service fasst DNS nur auf ausdrücklichen Wunsch an', async () => {
    await tool('delete_service').run({ id: 's' }, ctx);
    expect((actions.deleteServiceRun.mock.calls as unknown[][])[0][1]).toEqual({ removeDns: false });
    await tool('delete_service').run({ id: 's', removeDns: true }, ctx);
    expect((actions.deleteServiceRun.mock.calls as unknown[][])[1][1]).toEqual({ removeDns: true });
  });

  it('create_scope und delete_scope sind zwei Richtungen derselben Funktion', async () => {
    await tool('create_scope').run({ name: 'kunden' }, ctx);
    await tool('delete_scope').run({ name: 'kunden' }, ctx);
    expect((actions.changeScope.mock.calls as unknown[][]).map((c) => c[1])).toEqual(['scope-add', 'scope-remove']);
  });
});

describe('get_run', () => {
  afterEach(() => vi.useRealTimers());

  it('wartet, bis der Lauf fertig ist', async () => {
    vi.useFakeTimers();
    actions.getRun
      .mockResolvedValueOnce({ id: 'r', status: 'running' })
      .mockResolvedValueOnce({ id: 'r', status: 'running' })
      .mockResolvedValueOnce({ id: 'r', status: 'success' });

    const pending = tool('get_run').run({ runId: 'r', waitSeconds: 30 }, ctx);
    await vi.advanceTimersByTimeAsync(4000);

    await expect(pending).resolves.toEqual({ id: 'r', status: 'success' });
    expect(actions.getRun).toHaveBeenCalledTimes(3);
  });

  it('kommt ohne waitSeconds sofort zurück, auch wenn der Lauf noch läuft', async () => {
    actions.getRun.mockResolvedValue({ id: 'r', status: 'running' });
    await expect(tool('get_run').run({ runId: 'r' }, ctx)).resolves.toEqual({ id: 'r', status: 'running' });
    expect(actions.getRun).toHaveBeenCalledTimes(1);
  });

  it('wartet nie länger als die Obergrenze', async () => {
    vi.useFakeTimers();
    actions.getRun.mockResolvedValue({ id: 'r', status: 'running' });

    const pending = tool('get_run').run({ runId: 'r', waitSeconds: 10_000 }, ctx);
    await vi.advanceTimersByTimeAsync((MAX_WAIT_SECONDS + 10) * 1000);
    await pending;

    expect(actions.getRun.mock.calls.length).toBeLessThanOrEqual(MAX_WAIT_SECONDS / 2 + 1);
  });
});

describe('get_traffic_stats', () => {
  it('gibt die Summen und die meistbesuchten Ziele zurück, die Zeitreihe nur auf Wunsch', async () => {
    const short = (await tool('get_traffic_stats').run({}, ctx)) as Record<string, unknown>;
    expect(short.totals).toEqual({ requests: 10 });
    expect(short.busiest).toHaveLength(10);
    expect(short).not.toHaveProperty('series');

    const full = (await tool('get_traffic_stats').run({ top: 3, includeSeries: true }, ctx)) as Record<string, unknown>;
    expect(full.busiest).toEqual([
      { id: 'b0', requests: 30 },
      { id: 'b1', requests: 29 },
      { id: 'b2', requests: 28 },
    ]);
    expect(full.series).toHaveLength(1);
  });
});
