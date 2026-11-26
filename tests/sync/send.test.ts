import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { generatePairingKey, openRequest, parseHeader, sealResponse, SYNC_HEADER } from '@/lib/sync/envelope';
import { unpack, type BundleEntry, type Collected } from '@/lib/sync/bundle';
import { SYNC_PROTOCOL, type ApplyState, type NodeAnswer, type NodeReport } from '@/lib/sync/types';

/**
 * Der Hauptknoten: wann er überträgt, wann nicht, und was danach in Historie,
 * Zustand, Protokoll und Mail steht. Der Folgeknoten ist eine Attrappe hinter
 * `fetch`, die den echten Umschlag spricht: was sie nicht entschlüsseln kann,
 * beantwortet sie nicht.
 */

const KEY = generatePairingKey();
const PEER_URL = 'http://10.0.0.2:7080';

interface Peer {
  $id: string;
  name: string;
  url: string;
  key: string;
  lastError: string | null;
  [field: string]: unknown;
}

const state = vi.hoisted(() => ({
  role: 'primary' as string,
  peers: [] as Record<string, unknown>[],
  runs: [] as Record<string, unknown>[],
  audits: [] as { action: string; details: string }[],
  mails: [] as Record<string, unknown>[],
  config: 'global\n',
}));

vi.mock('@/lib/sync/store', () => ({
  getSyncSettings: vi.fn(async () => ({ role: state.role, nodeId: '1'.repeat(32) })),
  listPeers: vi.fn(async () => state.peers.map((peer) => ({ ...peer }))),
  updatePeer: vi.fn(async (id: string, patch: Record<string, unknown>) => {
    Object.assign(state.peers.find((peer) => peer.$id === id) ?? {}, patch);
  }),
  // Im Betrieb liegt der Schlüssel verschlüsselt: hier ist „gespeichert" der Klartext.
  openKey: (stored: string | null) => stored,
  createSyncRun: vi.fn(async (data: Record<string, unknown>) => {
    const run = { $id: `run${state.runs.length + 1}`, ...data };
    state.runs.push(run);
    return run;
  }),
  updateSyncRun: vi.fn(async (id: string, patch: Record<string, unknown>) => {
    Object.assign(state.runs.find((run) => run.$id === id) ?? {}, patch);
  }),
  RunLog: class {
    steps: { label: string; ok: boolean; detail?: string }[] = [];
    constructor(readonly runId: string) {}
    async add(label: string, ok: boolean, detail?: string) {
      this.steps.push({ label, ok, ...(detail ? { detail } : {}) });
      Object.assign(state.runs.find((run) => run.$id === this.runId) ?? {}, { steps: JSON.stringify(this.steps) });
    }
    get failed() {
      return this.steps.find((step) => !step.ok) ?? null;
    }
  },
}));

vi.mock('@/lib/sync/bundle', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/sync/bundle')>();
  return {
    ...actual,
    // Der Stand dieses Knotens: eine `haproxy.cfg`, deren Inhalt der Test ändert.
    collect: (): Collected => {
      const content = Buffer.from(state.config);
      const entry: BundleEntry = { root: 'haproxy', path: 'haproxy.cfg', type: 'file', mode: 0o644, size: content.length, sha256: createHash('sha256').update(content).digest('hex') };
      return { entries: [entry], contents: new Map([['haproxy:haproxy.cfg', content]]), roots: ['haproxy'], skipped: [] };
    },
  };
});

vi.mock('@/lib/sync/node', () => ({ HAPM_VERSION: '0.6.1', haproxyVersion: async () => '3.2.4', nodeName: () => 'proxy01' }));
vi.mock('@/lib/haproxy/provision', () => ({ withProxyLockLocal: async (_id: string, fn: () => Promise<unknown>) => fn() }));
vi.mock('@/lib/settings', () => ({ getSettings: async () => ({ exposure: 'public' }) }));
vi.mock('@/lib/audit', () => ({
  logAudit: vi.fn(async (entry: { action: string; details: string }) => {
    state.audits.push({ action: entry.action, details: entry.details });
  }),
  systemActor: () => ({ userId: 'system', userEmail: 'scheduler' }),
}));
vi.mock('@/lib/notifications', () => ({
  notify: vi.fn(async (event: Record<string, unknown>) => {
    state.mails.push(event);
    return 'sent';
  }),
}));

const { checkPeers, startManualSync, syncRunning } = await import('@/lib/sync/send');
const { fingerprintOf, collect } = await import('@/lib/sync/bundle');

/** Der Folgeknoten hinter `fetch`. */
const replica = {
  reachable: true,
  key: KEY,
  role: 'replica' as NodeReport['role'],
  primary: null as NodeReport['primary'],
  applied: null as NodeReport['applied'],
  variant: 'crowdsec=an;spoa=127.0.0.1:7423',
  intact: true as boolean | null,
  hapmVersion: '0.6.1',
  apply: null as ApplyState | null,
  /** Was er mit einem Paket tut. */
  outcome: 'success' as 'success' | 'error',
  received: [] as { seq: number; fingerprint: string; config: string }[],
  statusCalls: 0,
};

function report(): NodeReport {
  return {
    protocol: SYNC_PROTOCOL,
    nodeId: '2'.repeat(32),
    name: 'proxy02',
    role: replica.role,
    hapmVersion: replica.hapmVersion,
    haproxyVersion: '3.2.4',
    crowdsec: true,
    exposure: 'public',
    primary: replica.primary,
    applied: replica.applied,
    variant: replica.variant,
    intact: replica.intact,
    apply: replica.apply,
  };
}

async function fakeNode(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  if (!replica.reachable) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  expect(String(url)).toBe(`${PEER_URL}/api/sync/node`);
  const header = parseHeader(new Headers(init?.headers).get(SYNC_HEADER));
  if (!header) return Response.json({ success: false, error: 'kaputt' }, { status: 401 });
  let payload: Buffer;
  try {
    payload = openRequest(replica.key, header, Buffer.from(init?.body as Uint8Array));
  } catch {
    return Response.json({ success: false, error: 'Abgleich: Die Anmeldung ist ungültig.' }, { status: 401 });
  }

  let answer: NodeAnswer;
  if (header.kind === 'status') {
    replica.statusCalls += 1;
    answer = { ok: true, report: report() };
  } else if (replica.role !== 'replica') {
    answer = { ok: false, code: 'not_replica', report: report() };
  } else {
    const unpacked = unpack(payload);
    replica.received.push({
      seq: unpacked.meta.seq,
      fingerprint: unpacked.meta.fingerprint,
      config: unpacked.contents.get('haproxy:haproxy.cfg')!.toString(),
    });
    const ok = replica.outcome === 'success';
    replica.apply = {
      seq: unpacked.meta.seq,
      state: ok ? 'success' : 'error',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      steps: ok
        ? [{ label: 'Konfiguration geprüft', ok: true }, { label: 'HAProxy neu geladen', ok: true }]
        : [{ label: 'Konfiguration prüfen', ok: false, detail: "unknown keyword 'quic'" }, { label: 'Bisheriger Stand wiederhergestellt', ok: true }],
      error: ok ? null : "Konfiguration prüfen: unknown keyword 'quic'",
    };
    if (ok) {
      replica.applied = { fingerprint: unpacked.meta.fingerprint, seq: unpacked.meta.seq, at: new Date().toISOString(), variant: replica.variant };
      replica.primary = { nodeId: unpacked.meta.sender.nodeId, name: unpacked.meta.sender.name };
      replica.intact = true;
    }
    answer = { ok: true, accepted: true, seq: unpacked.meta.seq };
  }
  return new Response(new Uint8Array(sealResponse(replica.key, header.nonce, Buffer.from(JSON.stringify(answer)))), { status: 200 });
}

function peer(): Peer {
  return state.peers[0] as Peer;
}

function stepsOf(run: Record<string, unknown>): { label: string; ok: boolean; detail?: string }[] {
  return JSON.parse(String(run.steps ?? '[]'));
}

/** Die Runde mit ihren Wartezeiten zu Ende laufen lassen. */
async function finish(work: Promise<unknown>): Promise<void> {
  let done = false;
  void work.finally(() => {
    done = true;
  });
  for (let i = 0; i < 200 && (!done || syncRunning()); i++) await vi.advanceTimersByTimeAsync(500);
  await work;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.stubGlobal('fetch', vi.fn(fakeNode));
  state.role = 'primary';
  state.peers = [{ $id: 'p1', name: 'proxy02', url: PEER_URL, key: KEY, lastError: null, inSync: null, reachable: null, lastSyncAt: null, warnings: [] }];
  state.runs = [];
  state.audits = [];
  state.mails = [];
  state.config = 'global\n';
  Object.assign(replica, {
    reachable: true,
    key: KEY,
    role: 'replica',
    primary: null,
    applied: null,
    variant: 'crowdsec=an;spoa=127.0.0.1:7423',
    intact: true,
    hapmVersion: '0.6.1',
    apply: null,
    outcome: 'success',
    received: [],
    statusCalls: 0,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('nach einer Änderung und bei der regelmäßigen Prüfung', () => {
  it('überträgt an einen Folgeknoten, der noch keinen Stand trägt', async () => {
    await finish(checkPeers('change'));

    expect(replica.received).toHaveLength(1);
    expect(replica.received[0].config).toBe('global\n');
    expect(replica.received[0].fingerprint).toBe(fingerprintOf(collect().entries));
    expect(peer()).toMatchObject({ reachable: true, inSync: true, lastError: null, hapmVersion: '0.6.1' });
    expect(peer().lastSyncAt).toEqual(expect.any(String));

    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]).toMatchObject({ direction: 'send', trigger: 'change', status: 'success', peers: 'proxy02', triggeredBy: 'scheduler' });
    // Die Schritte des Folgeknotens stehen im Lauf des Hauptknotens.
    expect(stepsOf(state.runs[0]).map((step) => step.label)).toEqual(['Folgeknoten erreicht', 'Stand übertragen', 'Konfiguration geprüft', 'HAProxy neu geladen']);
    expect(state.audits).toEqual([{ action: 'sync_completed', details: 'proxy02: Stand übernommen' }]);
    expect(state.mails).toEqual([]);
  });

  it('überträgt nichts und schreibt keinen Lauf, wenn der Stand schon derselbe ist', async () => {
    await finish(checkPeers('change'));
    await finish(checkPeers('schedule'));
    await finish(checkPeers('schedule'));
    expect(replica.received).toHaveLength(1);
    expect(state.runs).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
    expect(peer().inSync).toBe(true);
  });

  it('überträgt erneut, sobald sich hier etwas geändert hat', async () => {
    await finish(checkPeers('change'));
    state.config = 'global\n    maxconn 4000\n';
    await finish(checkPeers('change'));
    expect(replica.received.map((entry) => entry.config)).toEqual(['global\n', 'global\n    maxconn 4000\n']);
    expect(replica.received[1].seq).toBeGreaterThan(replica.received[0].seq);
    expect(state.runs).toHaveLength(2);
  });

  it('überträgt erneut, wenn der Folgeknoten das Paket inzwischen anders anpassen würde', async () => {
    await finish(checkPeers('change'));
    // CrowdSec wurde dort abgeschaltet.
    replica.variant = 'crowdsec=aus;spoa=127.0.0.1:7423';
    await finish(checkPeers('schedule'));
    expect(replica.received).toHaveLength(2);
  });

  it('überschreibt einen Folgeknoten, auf dem jemand Dateien geändert hat, höchstens einmal je Stunde', async () => {
    await finish(checkPeers('change'));
    replica.intact = false;
    await finish(checkPeers('schedule'));
    expect(replica.received).toHaveLength(2);

    // Dort schreibt etwas dauerhaft dazwischen: nicht alle fünf Minuten überschreiben.
    replica.intact = false;
    await finish(checkPeers('schedule'));
    expect(replica.received).toHaveLength(2);
    expect(peer()).toMatchObject({ inSync: false, lastError: null });

    vi.setSystemTime(Date.now() + 61 * 60_000);
    await finish(checkPeers('schedule'));
    expect(replica.received).toHaveLength(3);
  });

  it('tut auf einem Knoten, der kein Hauptknoten ist, nichts', async () => {
    for (const role of ['single', 'replica']) {
      state.role = role;
      await finish(checkPeers('schedule'));
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(state.runs).toEqual([]);
  });
});

describe('wenn es scheitert', () => {
  it('ein Folgeknoten, der nicht antwortet: ein Lauf, eine Mail, und beim nächsten Mal keine zweite Zeile', async () => {
    replica.reachable = false;
    await finish(checkPeers('schedule'));
    expect(peer()).toMatchObject({ reachable: false, inSync: null });
    expect(peer().lastError).toContain('antwortet kein Knoten (ECONNREFUSED)');
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]).toMatchObject({ status: 'error' });
    expect(state.audits.map((entry) => entry.action)).toEqual(['sync_failed']);
    expect(state.mails).toEqual([expect.objectContaining({ type: 'sync_failed', peer: 'proxy02', url: PEER_URL })]);

    // Derselbe Fehler fünf Minuten später: er steht schon da.
    await finish(checkPeers('schedule'));
    expect(state.runs).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
    // Gemeldet wird trotzdem: die Dämpfung über den Tag macht `notify`.
    expect(state.mails).toHaveLength(2);
  });

  it('kommt der Folgeknoten zurück, bekommt er den Stand, und der Fehler ist weg', async () => {
    replica.reachable = false;
    await finish(checkPeers('schedule'));
    replica.reachable = true;
    await finish(checkPeers('schedule'));
    expect(replica.received).toHaveLength(1);
    expect(peer()).toMatchObject({ reachable: true, inSync: true, lastError: null });
    expect(state.runs.map((run) => run.status)).toEqual(['error', 'success']);
  });

  it('zwei Hauptknoten: es wird nichts übertragen, und es steht da, warum', async () => {
    replica.role = 'primary';
    await finish(checkPeers('change'));
    expect(replica.received).toEqual([]);
    expect(peer().lastError).toContain('ist selbst Hauptknoten');
    expect(peer()).toMatchObject({ reachable: true, inSync: false });
    expect(stepsOf(state.runs[0])).toEqual([{ label: 'Abgleich mit dem Folgeknoten', ok: false, detail: expect.stringContaining('proxy02: proxy02 ist selbst Hauptknoten') }]);
    expect(state.mails).toHaveLength(1);
  });

  it('ein Folgeknoten eines anderen Hauptknotens wird nicht überschrieben', async () => {
    replica.primary = { nodeId: '9'.repeat(32), name: 'proxy09' };
    await finish(checkPeers('change'));
    expect(replica.received).toEqual([]);
    expect(peer().lastError).toContain('an den Hauptknoten proxy09 gebunden');
  });

  it('ein falscher Kopplungsschlüssel', async () => {
    replica.key = generatePairingKey();
    await finish(checkPeers('change'));
    expect(peer()).toMatchObject({ reachable: true, lastError: 'Der Knoten lehnt den Kopplungsschlüssel ab.' });
    expect(replica.received).toEqual([]);
  });

  it('HAProxy lehnt den Stand dort ab: die Schritte von dort stehen im Lauf', async () => {
    replica.outcome = 'error';
    await finish(checkPeers('change'));
    expect(replica.received).toHaveLength(1);
    expect(peer()).toMatchObject({ inSync: false });
    expect(peer().lastError).toContain("proxy02 hat den Stand nicht übernommen: Konfiguration prüfen: unknown keyword 'quic'");
    expect(state.runs[0]).toMatchObject({ status: 'error' });
    expect(stepsOf(state.runs[0]).map((step) => `${step.ok ? 'ok' : 'fehler'} ${step.label}`)).toEqual([
      'ok Folgeknoten erreicht',
      'ok Stand übertragen',
      'fehler Konfiguration prüfen',
      'ok Bisheriger Stand wiederhergestellt',
    ]);
    expect(state.audits.map((entry) => entry.action)).toEqual(['sync_failed']);
    expect(state.mails).toHaveLength(1);
  });

  it('verschiedene Fassungen sind ein Hinweis, kein Hindernis', async () => {
    replica.hapmVersion = '0.6.0';
    await finish(checkPeers('change'));
    expect(replica.received).toHaveLength(1);
    expect(peer().warnings).toEqual([{ code: 'hapm_version', here: '0.6.1', there: '0.6.0' }]);
    expect(peer().inSync).toBe(true);
  });
});

describe('Jetzt abgleichen', () => {
  const actor = { userId: 'u1', userEmail: 'admin@example.org', ip: '203.0.113.9' };

  it('überträgt auch dann, wenn der Stand schon derselbe ist, und nennt den Lauf sofort', async () => {
    await finish(checkPeers('change'));
    const started = startManualSync(actor);
    const { runId } = await started;
    expect(state.runs.find((run) => run.$id === runId)).toMatchObject({ trigger: 'manual', status: 'running', triggeredBy: 'admin@example.org' });
    await finish(Promise.resolve());
    expect(replica.received).toHaveLength(2);
    expect(state.runs.find((run) => run.$id === runId)).toMatchObject({ status: 'success' });
    expect(state.audits.map((entry) => entry.action)).toEqual(['sync_completed', 'sync_started', 'sync_completed']);
  });

  it('geht nur auf einem Hauptknoten mit Folgeknoten', async () => {
    state.role = 'replica';
    await expect(startManualSync(actor)).rejects.toMatchObject({ status: 409 });
    state.role = 'primary';
    state.peers = [];
    await expect(startManualSync(actor)).rejects.toMatchObject({ status: 409 });
    expect(state.runs).toEqual([]);
  });

  it('nicht zweimal zugleich', async () => {
    const first = startManualSync(actor);
    await first;
    await expect(startManualSync(actor)).rejects.toMatchObject({ status: 409 });
    await finish(Promise.resolve());
    expect(syncRunning()).toBe(false);
  });

  it('schreibt denselben Fehler jedes Mal in den Lauf: wer drückt, will ihn sehen', async () => {
    replica.reachable = false;
    await startManualSync(actor);
    await finish(Promise.resolve());
    await startManualSync(actor);
    await finish(Promise.resolve());
    expect(state.runs.map((run) => run.status)).toEqual(['error', 'error']);
    expect(stepsOf(state.runs[1])).toHaveLength(1);
  });
});
