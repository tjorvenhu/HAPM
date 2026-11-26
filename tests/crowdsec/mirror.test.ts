import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SyncCrowdsec } from '@/lib/sync/data';

/**
 * CrowdSec im Abgleich zwischen Knoten (`lib/crowdsec/mirror.ts`): was ein
 * Hauptknoten weitergibt und welche `cscli`-Aufrufe ein Folgeknoten daraus
 * macht. `cscli` ist nachgebaut und führt Buch über Sperren und Freigaben.
 */

const NOW = Date.parse('2026-11-26T10:00:00.000Z');

interface Decision {
  id: number;
  value: string;
  origin: string;
  duration: string;
  scenario: string;
  type?: string;
  simulated?: boolean;
  createdAt?: string;
}

const world = vi.hoisted(() => ({
  decisions: [] as Decision[],
  allow: [] as { value: string; description: string; expiration: string }[],
  collections: [] as string[],
  crs: 'off' as string,
  calls: [] as string[],
  jobs: [] as string[],
  refuse: new Set<string>(),
}));

vi.mock('@/lib/crowdsec/cscli', () => {
  const run = async (args: string[]) => {
    const [area, verb] = args;
    if (area === 'decisions' && verb === 'list') {
      const alerts = world.decisions.map((decision) => ({
        id: decision.id + 100,
        created_at: decision.createdAt ?? '2026-11-26T08:00:00Z',
        scenario: decision.scenario,
        source: {},
        decisions: [{ ...decision, scope: decision.value.includes('/') ? 'Range' : 'Ip', type: decision.type ?? 'ban' }],
      }));
      return { code: 0, stdout: JSON.stringify(alerts), stderr: '' };
    }
    if (area === 'allowlists' && verb === 'inspect') {
      return { code: 0, stdout: JSON.stringify({ name: 'hapm', items: world.allow.map((entry) => ({ ...entry, created_at: '2026-11-01T00:00:00Z' })) }), stderr: '' };
    }
    if (area === 'hub' && verb === 'list') {
      return { code: 0, stdout: JSON.stringify({ collections: world.collections.map((name) => ({ name, status: 'enabled' })) }), stderr: '' };
    }
    world.calls.push(args.join(' '));
    if (area === 'decisions' && verb === 'add' && world.refuse.has(args[3])) {
      return { code: 1, stdout: '', stderr: 'level=fatal msg="abgelehnt"' };
    }
    if (area === 'decisions' && verb === 'add' && world.allow.some((entry) => entry.value === args[3])) {
      // Wörtlich, was cscli 1.8.2 sagt.
      return { code: 1, stdout: '', stderr: `Error: cscli decisions add: ${args[3]} is allowlisted by item ${args[3]} from hapm (Büro), use --bypass-allowlist to add the decision anyway` };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return {
    cscli: run,
    cscliOk: async (args: string[]) => {
      const result = await run(args);
      if (result.code !== 0) throw new Error('CrowdSec lehnt ab');
      return result;
    },
    cscliJson: async (args: string[]) => JSON.parse((await run(args)).stdout),
    cscliError: (result: { stderr: string }) => /msg="([^"]*)"/.exec(result.stderr)?.[1] ?? 'exit',
  };
});

vi.mock('@/lib/crowdsec/setup', () => ({
  currentCrsMode: () => world.crs,
  ensureAllowlist: vi.fn(async () => undefined),
}));

vi.mock('@/lib/crowdsec/rule-jobs', () => ({
  enqueueRuleChange: (job: { key: string; wanted: unknown; run: () => Promise<unknown> }) => ({ runId: 'run1', done: job.run() }),
}));

vi.mock('@/lib/crowdsec/actions', () => ({
  setCrsMode: vi.fn(async (body: { crs: string }, _actor: unknown, options: { reload?: boolean }) => {
    world.jobs.push(`crs=${body.crs} reload=${String(options.reload)}`);
  }),
  setCollection: vi.fn(async (body: { name: string; installed: boolean }, _actor: unknown, options: { reload?: boolean }) => {
    world.jobs.push(`${body.name}=${String(body.installed)} reload=${String(options.reload)}`);
  }),
}));

const { readCrowdsecState, applyCrowdsecState } = await import('@/lib/crowdsec/mirror');

const actor = { userId: 'system', userEmail: 'scheduler' };
const HTTP_DOS = 'crowdsecurity/http-dos';

function wanted(over: Partial<SyncCrowdsec> = {}): SyncCrowdsec {
  return { bans: [], allowlist: [], crs: 'off', collections: [], ...over };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  world.decisions = [];
  world.allow = [];
  world.collections = [];
  world.crs = 'off';
  world.calls = [];
  world.jobs = [];
  world.refuse = new Set();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('was ein Hauptknoten weitergibt', () => {
  it('die Sperren von Hand, die Freigaben und die Regeln', async () => {
    world.decisions = [
      { id: 1, value: '203.0.113.7', origin: 'cscli', duration: '4h0m0s', scenario: 'Gesperrt in HAPM', createdAt: '2026-11-26T09:00:00Z' },
      { id: 2, value: '198.51.100.0/24', origin: 'cscli-import', duration: '24h0m0s', scenario: 'Liste' },
    ];
    world.allow = [
      { value: '192.0.2.4', description: 'Büro', expiration: '0001-01-01T00:00:00.000Z' },
      { value: '192.0.2.5', description: 'kurz', expiration: '2026-12-03T07:28:03.629Z' },
    ];
    world.collections = ['crowdsecurity/haproxy', HTTP_DOS];
    world.crs = 'block';

    expect(await readCrowdsecState()).toEqual({
      bans: [
        { value: '203.0.113.7', scope: 'ip', reason: 'Gesperrt in HAPM', createdAt: '2026-11-26T09:00:00.000Z', until: '2026-11-26T14:00:00.000Z' },
        { value: '198.51.100.0/24', scope: 'range', reason: 'Liste', createdAt: '2026-11-26T08:00:00.000Z', until: '2026-11-27T10:00:00.000Z' },
      ],
      allowlist: [
        { value: '192.0.2.4', description: 'Büro', expiresAt: null },
        { value: '192.0.2.5', description: 'kurz', expiresAt: '2026-12-03T07:28:03.629Z' },
      ],
      crs: 'block',
      // Nur, was sich in HAPM schalten lässt: die Grundausstattung hat jeder Knoten.
      collections: [HTTP_DOS],
    });
  });

  it('nicht, was CrowdSec selbst verhängt hat', async () => {
    world.decisions = [
      { id: 1, value: '203.0.113.9', origin: 'crowdsec', duration: '3h59m57s', scenario: 'crowdsecurity/http-probing' },
      { id: 2, value: '203.0.113.10', origin: 'CAPI', duration: '100h0m0s', scenario: 'liste' },
      { id: 3, value: '203.0.113.11', origin: 'cscli', duration: '1h0m0s', scenario: 'probe', simulated: true },
      { id: 4, value: '203.0.113.12', origin: 'cscli', duration: '1h0m0s', scenario: 'captcha', type: 'captcha' },
    ];
    expect((await readCrowdsecState()).bans).toEqual([]);
  });
});

describe('was ein Folgeknoten daraus macht', () => {
  it('nichts, wenn es schon so vorliegt', async () => {
    world.decisions = [{ id: 1, value: '203.0.113.7', origin: 'cscli', duration: '4h0m30s', scenario: 'Gesperrt in HAPM' }];
    world.allow = [{ value: '192.0.2.4', description: 'Büro', expiration: '0001-01-01T00:00:00.000Z' }];
    world.collections = [HTTP_DOS];
    world.crs = 'block';
    const notes = await applyCrowdsecState(
      wanted({
        bans: [{ value: '203.0.113.7', scope: 'ip', reason: 'Gesperrt in HAPM', createdAt: null, until: '2026-11-26T14:00:00.000Z' }],
        allowlist: [{ value: '192.0.2.4', description: 'Büro', expiresAt: null }],
        crs: 'block',
        collections: [HTTP_DOS],
      }),
      actor
    );
    expect(notes).toEqual([]);
    expect(world.calls).toEqual([]);
    // Kein Lauf an den Regeln: der startete CrowdSec neu.
    expect(world.jobs).toEqual([]);
  });

  it('setzt und entfernt Freigaben, dann Sperren, und lässt die Sperren von CrowdSec selbst stehen', async () => {
    world.decisions = [
      { id: 1, value: '203.0.113.1', origin: 'cscli', duration: '4h0m0s', scenario: 'alt' },
      { id: 2, value: '203.0.113.2', origin: 'crowdsec', duration: '4h0m0s', scenario: 'crowdsecurity/http-probing' },
    ];
    world.allow = [{ value: '192.0.2.99', description: 'alt', expiration: '0001-01-01T00:00:00.000Z' }];

    const notes = await applyCrowdsecState(
      wanted({
        bans: [
          { value: '203.0.113.7', scope: 'ip', reason: 'Gesperrt in HAPM', createdAt: null, until: '2026-11-26T14:00:00.000Z' },
          { value: '198.51.100.0/24', scope: 'range', reason: '', createdAt: null, until: '2026-11-27T10:00:00.000Z' },
        ],
        allowlist: [
          { value: '192.0.2.4', description: 'Büro', expiresAt: null },
          { value: '192.0.2.5', description: '', expiresAt: '2026-11-27T10:00:00.000Z' },
        ],
      }),
      actor
    );

    expect(world.calls).toEqual([
      'allowlists remove hapm 192.0.2.99',
      'allowlists add hapm 192.0.2.4 -d Büro',
      'allowlists add hapm 192.0.2.5 -d HAPM -e 86400s',
      'decisions delete --id 1',
      'decisions add --ip 203.0.113.7 --duration 14400s --type ban --reason Gesperrt in HAPM',
      'decisions add --range 198.51.100.0/24 --duration 86400s --type ban --reason Gesperrt in HAPM',
    ]);
    expect(notes).toEqual(['Freigaben: 2 gesetzt, 1 entfernt', 'Sperren: 2 gesetzt, 1 aufgehoben']);
  });

  it('schaltet die Regeln nur, wo sie abweichen, und lädt nicht je Änderung neu', async () => {
    world.crs = 'off';
    world.collections = [];
    const notes = await applyCrowdsecState(wanted({ crs: 'block', collections: [HTTP_DOS] }), actor);
    expect(world.jobs).toEqual(['crs=block reload=false', `${HTTP_DOS}=true reload=false`]);
    expect(notes).toEqual(['OWASP-Regeln: an', 'HTTP-Flut: an']);

    world.jobs = [];
    world.crs = 'block';
    world.collections = [HTTP_DOS];
    expect(await applyCrowdsecState(wanted({ crs: 'off', collections: [] }), actor)).toEqual(['OWASP-Regeln: aus', 'HTTP-Flut: aus']);
    expect(world.jobs).toEqual(['crs=off reload=false', `${HTTP_DOS}=false reload=false`]);
  });

  it('fasst nichts an, was es hier nicht gibt oder nicht kennt', async () => {
    const notes = await applyCrowdsecState(wanted({ crs: 'detect', collections: ['fremd/sammlung'] }), actor);
    expect(notes).toEqual([]);
    expect(world.jobs).toEqual([]);
  });

  it('nimmt hin, dass CrowdSec eine freigegebene Adresse nicht sperrt', async () => {
    world.allow = [{ value: '192.0.2.4', description: 'Büro', expiration: '0001-01-01T00:00:00.000Z' }];
    const notes = await applyCrowdsecState(
      wanted({
        allowlist: [{ value: '192.0.2.4', description: 'Büro', expiresAt: null }],
        bans: [{ value: '192.0.2.4', scope: 'ip', reason: 'x', createdAt: null, until: '2026-11-26T14:00:00.000Z' }],
      }),
      actor
    );
    expect(notes).toEqual([]);
  });

  it('meldet eine Sperre, die CrowdSec nicht annimmt', async () => {
    world.refuse.add('203.0.113.7');
    await expect(
      applyCrowdsecState(wanted({ bans: [{ value: '203.0.113.7', scope: 'ip', reason: 'x', createdAt: null, until: '2026-11-26T14:00:00.000Z' }] }), actor)
    ).rejects.toThrow(/203\.0\.113\.7: abgelehnt/);
  });
});
