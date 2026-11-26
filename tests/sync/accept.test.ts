import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { pack, type BundleEntry, type Collected } from '@/lib/sync/bundle';
import type { ApplyResult } from '@/lib/sync/apply-core';
import type { DataApplyResult } from '@/lib/sync/data-apply';
import { crowdsecFingerprint, dataFingerprint, type SyncData } from '@/lib/sync/data';
import { sampleSyncData } from '../helpers/sync-data';

/**
 * Der Folgeknoten entscheidet, ob er ein Paket annimmt. Hier stehen die
 * Absagen: kein Folgeknoten (zwei Hauptknoten), ein fremder Hauptknoten, ein
 * älteres Paket, ein laufendes Anwenden. Das Anwenden selbst ist ersetzt, es
 * steht in `tests/sync/apply.test.ts` und `pnpm sync:verify`.
 */

const PRIMARY = { nodeId: 'a'.repeat(32), name: 'proxy01', hapmVersion: '0.6.1', haproxyVersion: '3.2.4', exposure: 'public', usesCrowdsec: false };

const state = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  patches: [] as Record<string, unknown>[],
  runs: [] as Record<string, unknown>[],
  audits: [] as { action: string; details: string }[],
  result: null as unknown,
  release: null as null | (() => void),
  /** Was das Einsetzen des Datenteils ergibt, und womit es gerufen wurde. */
  dataResult: null as unknown,
  dataCalls: [] as unknown[],
}));

vi.mock('@/lib/sync/store', () => ({
  getSyncSettings: vi.fn(async () => state.settings),
  updateSyncSettings: vi.fn(async (patch: Record<string, unknown>) => {
    state.patches.push(patch);
    Object.assign(state.settings, patch);
    return state.settings;
  }),
  createSyncRun: vi.fn(async (data: Record<string, unknown>) => {
    const run = { $id: `run${state.runs.length + 1}`, ...data };
    state.runs.push(run);
    return run;
  }),
  updateSyncRun: vi.fn(async (id: string, patch: Record<string, unknown>) => {
    Object.assign(state.runs.find((run) => run.$id === id) ?? {}, patch);
  }),
  closeOpenSyncRuns: vi.fn(async () => 0),
  RunLog: class {
    steps: { label: string; ok: boolean }[] = [];
    constructor(readonly runId: string) {}
    async add(label: string, ok: boolean) {
      this.steps.push({ label, ok });
    }
  },
}));

vi.mock('@/lib/sync/apply-core', () => ({
  applyUnpacked: vi.fn(async () => {
    if (state.release === null) return state.result;
    // Hält das Anwenden offen, bis der Test es freigibt.
    await new Promise<void>((resolve) => {
      const previous = state.release!;
      state.release = () => {
        previous();
        resolve();
      };
    });
    return state.result;
  }),
}));

vi.mock('@/lib/sync/data-apply', () => ({
  applyData: vi.fn(async (data: unknown, onStep?: (step: { label: string; ok: boolean; detail?: string }) => Promise<void>) => {
    state.dataCalls.push(data);
    const result = state.dataResult as { steps: { label: string; ok: boolean; detail?: string }[] };
    for (const step of result.steps) await onStep?.(step);
    return result;
  }),
}));

vi.mock('@/lib/sync/node', () => ({
  localNode: () => ({ crowdsec: true, spoaAddress: '127.0.0.1:7423' }),
  nodeReport: vi.fn(async () => ({ name: 'proxy02', role: state.settings.role })),
}));

vi.mock('@/lib/haproxy/provision', () => ({
  withProxyLockLocal: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('@/lib/audit', () => ({
  logAudit: vi.fn(async (entry: { action: string; details: string }) => {
    state.audits.push({ action: entry.action, details: entry.details });
  }),
  systemActor: () => ({ userId: 'system', userEmail: 'scheduler' }),
}));
vi.mock('@/lib/crowdsec/paths', () => ({ crowdsecInstalled: () => false }));
vi.mock('@/lib/ssh', () => ({ sshExec: vi.fn() }));

const { acceptBundle, currentApply } = await import('@/lib/sync/apply');

function bundle(seq: number, sender = PRIMARY, data: SyncData | null = null): Buffer {
  const content = Buffer.from('global\n');
  const entry: BundleEntry = { root: 'haproxy', path: 'haproxy.cfg', type: 'file', mode: 0o644, size: content.length, sha256: createHash('sha256').update(content).digest('hex') };
  const collected: Collected = { entries: [entry], contents: new Map([['haproxy:haproxy.cfg', content]]), roots: ['haproxy'], skipped: [] };
  return pack({ seq, sender }, collected, data).bundle;
}

const DATA_OK: DataApplyResult = {
  ok: true,
  dbOk: true,
  steps: [{ label: 'Konten übernommen', ok: true, detail: '2 Konten, 1 neu' }],
  changes: ['Konten: 2 Konten, 1 neu'],
  localFingerprint: 'e'.repeat(64),
  crowdsec: true,
};

const SUCCESS: ApplyResult = { ok: true, steps: [{ label: 'HAProxy neu geladen', ok: true }], crowdsec: 'unused', localFingerprint: 'c'.repeat(64), changed: true };

/** Bis das abgekoppelte Anwenden durch ist. */
async function settled(): Promise<void> {
  for (let i = 0; i < 20 && currentApply()?.state === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

beforeEach(async () => {
  state.release?.();
  await settled();
  state.settings = { role: 'replica', nodeId: 'b'.repeat(32), primary: null, applied: null, rejected: null };
  state.patches = [];
  state.runs = [];
  state.audits = [];
  state.result = SUCCESS;
  state.release = null;
  state.dataResult = DATA_OK;
  state.dataCalls = [];
});

describe('ein Paket annehmen', () => {
  it('nimmt das erste an, bindet sich an den Absender und merkt sich den Stand', async () => {
    const answer = await acceptBundle(bundle(100));
    expect(answer).toEqual({ ok: true, accepted: true, seq: 100 });
    await settled();

    expect(currentApply()).toMatchObject({ seq: 100, state: 'success', error: null });
    expect(state.settings.primary).toEqual({ nodeId: PRIMARY.nodeId, name: 'proxy01' });
    expect(state.settings.applied).toMatchObject({ seq: 100, localFingerprint: 'c'.repeat(64), crowdsec: 'unused', variant: 'crowdsec=an;spoa=127.0.0.1:7423' });
    expect(state.runs[0]).toMatchObject({ direction: 'receive', trigger: 'incoming', status: 'success', peers: 'proxy01', triggeredBy: 'proxy01' });
    expect(state.audits.map((entry) => entry.action)).toEqual(['sync_applied']);
  });

  it('antwortet, bevor angewendet ist', async () => {
    // Das Neuladen kann länger dauern, als eine Anfrage wartet.
    state.release = () => undefined;
    const answer = await acceptBundle(bundle(100));
    expect(answer).toMatchObject({ ok: true, accepted: true });
    expect(currentApply()).toMatchObject({ seq: 100, state: 'running' });
    state.release();
    await settled();
    expect(currentApply()).toMatchObject({ state: 'success' });
  });

  it('merkt sich nach einem gescheiterten Anwenden keinen neuen Stand', async () => {
    state.result = { ok: false, steps: [{ label: 'Konfiguration prüfen', ok: false, detail: 'unknown keyword' }], crowdsec: 'unused', localFingerprint: null, changed: false };
    await acceptBundle(bundle(100));
    await settled();
    expect(currentApply()).toMatchObject({ state: 'error', error: 'Konfiguration prüfen: unknown keyword' });
    expect(state.settings.applied).toBeNull();
    expect(state.settings.primary).toBeNull();
    expect(state.runs[0]).toMatchObject({ status: 'error' });
    expect(state.audits.map((entry) => entry.action)).toEqual(['sync_apply_failed']);
  });
});

describe('der Datenteil eines Pakets', () => {
  it('wird nach den Dateien eingesetzt, und der Knoten merkt sich seine Fingerabdrücke', async () => {
    const data = sampleSyncData();
    await acceptBundle(bundle(100, PRIMARY, data));
    await settled();

    expect(state.dataCalls).toEqual([data]);
    // Die Schritte stehen in der Auskunft: daraus schreibt der Hauptknoten seinen Lauf.
    expect(currentApply()).toMatchObject({ state: 'success', steps: [{ label: 'Konten übernommen', detail: '2 Konten, 1 neu' }] });
    expect(state.settings.applied).toMatchObject({
      seq: 100,
      dataFingerprint: dataFingerprint(data),
      localDataFingerprint: 'e'.repeat(64),
      crowdsecFingerprint: crowdsecFingerprint(data.crowdsec!),
    });
    // Ein Konto, das der Abgleich angelegt hat, steht im Protokoll dieses Knotens.
    expect(state.audits).toEqual([{ action: 'sync_applied', details: 'Stand von proxy01 übernommen. Konten: 2 Konten, 1 neu' }]);
  });

  it('fehlt in einem Paket nur mit Dateien: dann bleibt, was der Knoten zuletzt übernommen hat', async () => {
    state.settings.applied = { seq: 50, dataFingerprint: 'd'.repeat(64), localDataFingerprint: 'e'.repeat(64), crowdsecFingerprint: 'c'.repeat(64) };
    await acceptBundle(bundle(100));
    await settled();
    expect(state.dataCalls).toEqual([]);
    expect(state.settings.applied).toMatchObject({ seq: 100, dataFingerprint: 'd'.repeat(64), localDataFingerprint: 'e'.repeat(64), crowdsecFingerprint: 'c'.repeat(64) });
  });

  it('ohne CrowdSec lässt dessen übernommenen Stand stehen', async () => {
    state.settings.applied = { seq: 50, crowdsecFingerprint: 'c'.repeat(64) };
    state.dataResult = { ...DATA_OK, crowdsec: null };
    const data = { ...sampleSyncData(), crowdsec: null };
    await acceptBundle(bundle(100, PRIMARY, data));
    await settled();
    expect(state.settings.applied).toMatchObject({ dataFingerprint: dataFingerprint(data), crowdsecFingerprint: 'c'.repeat(64) });
  });

  it('gilt als nicht übernommen, wenn ein Teil scheitert, die Dateien aber gelten', async () => {
    state.dataResult = {
      ok: false,
      dbOk: false,
      steps: [{ label: 'Konten übernehmen', ok: false, detail: 'Datenbank nicht erreichbar' }],
      changes: [],
      localFingerprint: null,
      crowdsec: true,
    } satisfies DataApplyResult;
    const data = sampleSyncData();
    await acceptBundle(bundle(100, PRIMARY, data));
    await settled();

    expect(currentApply()).toMatchObject({ state: 'error', error: 'Konten übernehmen: Datenbank nicht erreichbar' });
    // Der Hauptknoten sieht daran, dass er erneut schicken muss.
    expect(state.settings.applied).toMatchObject({ seq: 100, dataFingerprint: null, crowdsecFingerprint: crowdsecFingerprint(data.crowdsec!) });
    expect(state.runs[0]).toMatchObject({ status: 'error' });
    expect(state.audits.map((entry) => entry.action)).toEqual(['sync_apply_failed']);
  });

  it('gilt für CrowdSec als nicht übernommen, wenn nur das scheitert', async () => {
    state.dataResult = { ...DATA_OK, ok: false, crowdsec: false, steps: [{ label: 'CrowdSec übernehmen', ok: false, detail: 'antwortet nicht' }] };
    const data = sampleSyncData();
    await acceptBundle(bundle(100, PRIMARY, data));
    await settled();
    expect(currentApply()).toMatchObject({ state: 'error' });
    expect(state.settings.applied).toMatchObject({ dataFingerprint: dataFingerprint(data), crowdsecFingerprint: null });
  });

  it('wird auch eingesetzt, wenn HAProxy die Dateien ablehnt', async () => {
    // Ein entferntes Konto soll nicht daran hängen, ob eine haproxy.cfg hier lädt.
    state.result = { ok: false, steps: [{ label: 'Konfiguration prüfen', ok: false, detail: 'unknown keyword' }], crowdsec: 'unused', localFingerprint: null, changed: false };
    await acceptBundle(bundle(100, PRIMARY, sampleSyncData()));
    await settled();
    expect(state.dataCalls).toHaveLength(1);
    expect(currentApply()).toMatchObject({ state: 'error', error: 'Konfiguration prüfen: unknown keyword' });
    expect(state.settings.applied).toBeNull();
  });
});

describe('ein Paket ablehnen', () => {
  it('dessen Datenteil niemanden mehr hereinließe', async () => {
    const data = sampleSyncData();
    data.accounts.accounts.forEach((account) => (account.password = null));
    const answer = await acceptBundle(bundle(100, PRIMARY, data));
    expect(answer).toMatchObject({ ok: false, code: 'invalid', detail: expect.stringContaining('kein Konto mit Passwort') });
    expect(state.runs).toEqual([]);
    expect(state.dataCalls).toEqual([]);
  });

  it.each(['primary', 'single'] as const)('als %s: dieser Knoten ist kein Folgeknoten', async (role) => {
    // Zwei Hauptknoten: der alte kommt zurück, während dieser befördert wurde.
    state.settings.role = role;
    const answer = await acceptBundle(bundle(100));
    expect(answer).toMatchObject({ ok: false, code: 'not_replica' });
    await settled();
    expect(state.runs).toEqual([]);
    // Es steht danach auf der Seite und im Protokoll.
    expect(state.settings.rejected).toMatchObject({ code: 'not_replica', name: 'proxy01', nodeId: PRIMARY.nodeId });
    expect(state.audits).toEqual([{ action: 'sync_rejected', details: expect.stringContaining('kein Folgeknoten') }]);
  });

  it('von einem anderen Hauptknoten als dem, an den er gebunden ist', async () => {
    state.settings.primary = { nodeId: '9'.repeat(32), name: 'proxy09' };
    const answer = await acceptBundle(bundle(100));
    expect(answer).toMatchObject({ ok: false, code: 'other_primary' });
    expect(state.runs).toEqual([]);
    expect(state.settings.rejected).toMatchObject({ code: 'other_primary', name: 'proxy01' });
    expect(state.audits[0].action).toBe('sync_rejected');
  });

  it('das nicht neuer ist als das zuletzt übernommene', async () => {
    // Ein mitgeschnittenes Paket soll den Knoten nicht auf einen früheren Stand zurückstellen.
    state.settings.applied = { seq: 100 };
    expect(await acceptBundle(bundle(100))).toMatchObject({ ok: false, code: 'stale' });
    expect(await acceptBundle(bundle(99))).toMatchObject({ ok: false, code: 'stale' });
    expect(await acceptBundle(bundle(101))).toMatchObject({ ok: true, accepted: true });
    await settled();
  });

  it('solange noch eines angewendet wird', async () => {
    state.release = () => undefined;
    await acceptBundle(bundle(100));
    expect(await acceptBundle(bundle(101))).toMatchObject({ ok: false, code: 'busy' });
    state.release();
    await settled();
  });

  it('das von ihm selbst stammt', async () => {
    const answer = await acceptBundle(bundle(100, { ...PRIMARY, nodeId: 'b'.repeat(32) }));
    expect(answer).toMatchObject({ ok: false, code: 'invalid' });
    expect(state.runs).toEqual([]);
  });

  it('das kein Paket ist, mit dem Grund', async () => {
    const answer = await acceptBundle(Buffer.from('kein paket'));
    expect(answer).toMatchObject({ ok: false, code: 'invalid', detail: 'Das Paket lässt sich nicht auspacken.' });
    expect(state.runs).toEqual([]);
    expect(state.patches).toEqual([]);
  });
});
