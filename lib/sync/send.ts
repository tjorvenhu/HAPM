/**
 * Der Hauptknoten: den eigenen Stand packen, an die Folgeknoten schicken und
 * abwarten, was sie daraus machen.
 *
 * ── Wann abgeglichen wird ──
 *
 *  - nach jedem Vorgang, der die Sperre der Läufe hielt (`onProxyChange`,
 *    gesetzt vom Scheduler), drei Sekunden später und zusammengefasst,
 *  - ebenso nach jeder Handlung an Konten, Einstellungen, DNS-Zonen, API-Keys
 *    und CrowdSec (`onDataChange`, `kick.ts`),
 *  - nach dem täglichen Lauf von acme.sh,
 *  - alle fünf Minuten (Scheduler),
 *  - auf Knopfdruck („Jetzt abgleichen").
 *
 * Alle außer dem Knopf fragen jeden Folgeknoten, welchen Stand er trägt, und
 * übertragen nur, wenn ein Fingerabdruck abweicht (Dateien, Daten, CrowdSec),
 * er sich inzwischen anders anpassen würde (CrowdSec wurde dort eingeschaltet)
 * oder jemand dort Dateien oder Daten geändert hat. Der Knopf überträgt immer.
 *
 * ── Was in der Historie steht ──
 *
 * Ein Lauf entsteht nur, wenn etwas übertragen wird oder ein Folgeknoten neu
 * ausfällt. Eine Prüfung, die nichts zu tun findet, hinterlässt nur den
 * Zeitpunkt an der Gegenstelle. Sonst stünden dort 288 Zeilen am Tag, und ein
 * Folgeknoten, der einen Tag lang nicht antwortet, füllte sie mit demselben
 * Fehler.
 *
 * Ein gescheiterter Abgleich hält nichts auf: der Vorgang, der ihn ausgelöst
 * hat, ist längst fertig. Er steht an der Gegenstelle, im Protokoll und geht
 * als Mail hinaus (`sync_failed`).
 */

import { ApiError } from '../api';
import { logAudit, systemActor } from '../audit';
import { LOCAL_SERVER_ID } from '../helpers';
import { getSettings } from '../settings';
import { HAPROXY_CFG, usesCrowdsec } from '../haproxy/config';
import { withProxyLockLocal } from '../haproxy/provision';
import { notify } from '../notifications';
import { msg, msgid } from '../i18n/translate';
import { ROOT_DIRS, collect, pack, type BundleMeta } from './bundle';
import { collectData } from './data-collect';
import { ENVELOPE_OVERHEAD, SYNC_HEADER, openResponse, sealRequest, type EnvelopeKind } from './envelope';
import { HAPM_VERSION, haproxyVersion, nodeName } from './node';
import { MAX_APPLY_BYTES } from './receive';
import { RunLog, createSyncRun, getSyncSettings, listPeers, openKey, updatePeer, updateSyncRun, type SyncPeer } from './store';
import { carriesState, refusalOf, tookState, warningsFor } from './compare';
import type { NodeAnswer, NodeReport, SyncTrigger } from './types';

export interface SyncActor {
  userId: string;
  userEmail: string;
  ip?: string;
}

/* ── Die Leitung ── */

/** Ein Aufruf an eine Gegenstelle ist gescheitert. `message` ist ein deutscher Satz für Lauf und Zustand. */
export class NodeCallError extends Error {
  constructor(
    message: string,
    /** `false`: die Gegenstelle hat geantwortet, nur nicht wie erhofft. */
    readonly unreachable: boolean
  ) {
    super(message);
    this.name = 'NodeCallError';
  }
}

function causeOf(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'keine Antwort in der Zeit';
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    return cause?.code || cause?.message || err.message;
  }
  return String(err);
}

export interface NodeTarget {
  url: string;
  key: string;
}

/**
 * Eine Anfrage an den Endpunkt eines anderen Knotens, verschlüsselt mit dem
 * Kopplungsschlüssel. Die Antwort wird geprüft: nur ein Knoten mit demselben
 * Schlüssel kann sie geschrieben haben.
 */
export async function callNode(target: NodeTarget, kind: EnvelopeKind, payload: Buffer, timeoutMs: number): Promise<NodeAnswer> {
  const sealed = sealRequest(target.key, kind, payload);
  let res: Response;
  try {
    res = await fetch(`${target.url}/api/sync/node`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', [SYNC_HEADER]: sealed.header },
      body: new Uint8Array(sealed.body),
      signal: AbortSignal.timeout(timeoutMs),
      // Eine Weiterleitung führte das Paket an eine Adresse, die niemand eingetragen hat.
      redirect: 'error',
      cache: 'no-store',
    });
  } catch (err) {
    throw new NodeCallError(`Unter ${target.url} antwortet kein Knoten (${causeOf(err)}).`, true);
  }

  if (res.status !== 200) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string') detail = body.error;
    } catch {
      // Keine Antwort von HAPM: dann sagt der Status alles, was zu sagen ist.
    }
    if (res.status === 401) throw new NodeCallError('Der Knoten lehnt den Kopplungsschlüssel ab.', false);
    if (res.status === 404) throw new NodeCallError(`Unter ${target.url} läuft kein HAPM mit Abgleich (404).`, false);
    throw new NodeCallError(detail || `Der Knoten antwortet mit ${res.status}.`, false);
  }

  let answer: NodeAnswer;
  try {
    const plain = openResponse(target.key, sealed.nonce, Buffer.from(await res.arrayBuffer()));
    answer = JSON.parse(plain.toString('utf8')) as NodeAnswer;
  } catch {
    throw new NodeCallError(`Die Antwort unter ${target.url} stammt nicht von dem gekoppelten Knoten.`, false);
  }
  return answer;
}

const STATUS_MS = 20_000;
const SEND_MS = 180_000;
const APPLY_WAIT_MS = 5 * 60_000;

/** Die Auskunft eines Knotens. Wirft `NodeCallError`. */
export async function askNode(target: NodeTarget): Promise<NodeReport> {
  const answer = await callNode(target, 'status', Buffer.from('{}', 'utf8'), STATUS_MS);
  if (!answer.ok || !('report' in answer) || !answer.report) {
    throw new NodeCallError('Der Knoten gibt keine Auskunft über sich.', false);
  }
  return answer.report;
}

/* ── Packen ── */

export interface Packed {
  bundle: Buffer;
  meta: BundleMeta;
}

const globalState = globalThis as unknown as {
  __hapmSyncSend?: {
    running: boolean;
    again: boolean;
    timer: ReturnType<typeof setTimeout> | null;
    lastSeq: number;
    /** Wann zuletzt nur deshalb übertragen wurde, weil der Folgeknoten abwich. */
    repaired: Map<string, number>;
  };
};

function state() {
  return (globalState.__hapmSyncSend ??= { running: false, again: false, timer: null, lastSeq: 0, repaired: new Map() });
}

/** Der Stand dieses Knotens als Paket. Gelesen hinter der Sperre: kein Vorgang schreibt währenddessen. */
export async function packState(): Promise<Packed> {
  const collected = await withProxyLockLocal(LOCAL_SERVER_ID, async () => collect(ROOT_DIRS));
  const cfg = collected.contents.get('haproxy:haproxy.cfg');
  if (!cfg) {
    throw new ApiError(msg('{file} fehlt auf diesem Knoten. Es gibt nichts abzugleichen.', { file: HAPROXY_CFG }), 409);
  }
  const [sync, settings, version, data] = await Promise.all([getSyncSettings(), getSettings(), haproxyVersion(), collectData()]);
  const memory = state();
  // Streng steigend, auch wenn zwei Läufe in derselben Millisekunde packen.
  const seq = Math.max(Date.now(), memory.lastSeq + 1);
  memory.lastSeq = seq;
  const packed = pack(
    {
      seq,
      sender: {
        nodeId: sync.nodeId,
        name: nodeName(),
        hapmVersion: HAPM_VERSION,
        haproxyVersion: version,
        exposure: settings.exposure,
        usesCrowdsec: usesCrowdsec(cfg.toString('utf8')),
      },
    },
    collected,
    data
  );
  if (packed.bundle.length + ENVELOPE_OVERHEAD > MAX_APPLY_BYTES) {
    throw new ApiError(
      msg('Der Stand ist gepackt {size} MB groß. Der Abgleich überträgt höchstens {max} MB.', {
        size: Math.ceil(packed.bundle.length / 1024 / 1024),
        max: Math.floor(MAX_APPLY_BYTES / 1024 / 1024),
      }),
      409
    );
  }
  return packed;
}

function refusalText(answer: Extract<NodeAnswer, { ok: false }>, peerName: string, ownNodeId: string): string {
  if (answer.report) {
    const known = refusalOf(answer.report, ownNodeId);
    if (known) return known;
  }
  switch (answer.code) {
    case 'stale':
      return `${peerName} trägt schon einen neueren Stand. Die Uhr dieses Knotens geht vermutlich nach.`;
    case 'busy':
      return `${peerName} wendet gerade einen Stand an.`;
    case 'invalid':
      return `${peerName} lehnt das Paket ab: ${answer.detail ?? 'ohne Grund'}`;
    case 'protocol':
      return `${peerName} spricht eine andere Fassung des Abgleichs.`;
    default:
      return `${peerName} nimmt den Stand nicht an (${answer.code}).`;
  }
}

/* ── Eine Runde ── */

/** Höchstens so oft wird ein Folgeknoten nur deshalb überschrieben, weil er selbst abweicht. */
const REPAIR_PAUSE_MS = 60 * 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function sizeLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

interface RoundContext {
  trigger: SyncTrigger;
  /** `true`: übertragen, auch wenn der Stand schon gleich ist, und jeden Fehler in den Lauf schreiben. */
  force: boolean;
  ownNodeId: string;
  getPacked: () => Promise<Packed>;
  /** Der Lauf dieser Runde. Entsteht erst, wenn es etwas zu berichten gibt. */
  getLog: () => Promise<RunLog>;
}

type PeerOutcome =
  | { peer: SyncPeer; result: 'in-sync' | 'synced' | 'postponed' }
  | { peer: SyncPeer; result: 'failed'; error: string; reported: boolean };

async function syncPeer(peer: SyncPeer, ctx: RoundContext): Promise<PeerOutcome> {
  const now = () => new Date().toISOString();
  const fail = async (error: string, reachable: boolean | null): Promise<PeerOutcome> => {
    // Derselbe Fehler wie beim letzten Mal ist nichts Neues: er steht schon da.
    const reported = ctx.force || peer.lastError !== error;
    if (reported) await (await ctx.getLog()).add(msgid('Abgleich mit dem Folgeknoten'), false, `${peer.name}: ${error}`);
    await updatePeer(peer.$id, { lastCheckAt: now(), reachable, inSync: reachable === false ? null : false, lastError: error }).catch(() => undefined);
    return { peer, result: 'failed', error, reported };
  };

  const key = openKey(peer.key);
  if (!key) return fail('Der gespeicherte Kopplungsschlüssel lässt sich nicht lesen. Den Folgeknoten entfernen und neu hinzufügen.', null);
  const target: NodeTarget = { url: peer.url, key };

  let report: NodeReport;
  try {
    report = await askNode(target);
  } catch (err) {
    if (err instanceof NodeCallError) return fail(err.message, !err.unreachable);
    throw err;
  }
  const refusal = refusalOf(report, ctx.ownNodeId);
  if (refusal) return fail(refusal, true);

  let packed: Packed;
  try {
    packed = await ctx.getPacked();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), true);
  }
  const { meta, bundle } = packed;
  const warnings = warningsFor(report, meta);
  const seen = { nodeId: report.nodeId, hapmVersion: report.hapmVersion, haproxyVersion: report.haproxyVersion, warnings };

  if (!ctx.force && carriesState(report, meta)) {
    await updatePeer(peer.$id, { ...seen, lastCheckAt: now(), reachable: true, inSync: true, lastError: null }).catch(() => undefined);
    return { peer, result: 'in-sync' };
  }
  if (!ctx.force) {
    const waiting = { ...seen, lastCheckAt: now(), reachable: true, inSync: false, lastError: null };
    // Der Folgeknoten ist noch am vorigen Stand: die nächste Prüfung sieht nach.
    if (report.apply?.state === 'running') {
      await updatePeer(peer.$id, waiting).catch(() => undefined);
      return { peer, result: 'postponed' };
    }
    // Hier hat sich nichts geändert, dort hat jemand Dateien oder Daten angefasst.
    // Nicht bei jeder Prüfung überschreiben: schreibt dort etwas dauerhaft
    // dazwischen, wäre das ein Abgleich alle fünf Minuten. Eine andere Anpassung
    // (CrowdSec dort umgestellt) ist dagegen ein Grund, der sich mit dem
    // Abgleich erledigt.
    if (tookState(report, meta)) {
      const last = state().repaired.get(peer.$id) ?? 0;
      if (Date.now() - last < REPAIR_PAUSE_MS) {
        await updatePeer(peer.$id, waiting).catch(() => undefined);
        return { peer, result: 'postponed' };
      }
      state().repaired.set(peer.$id, Date.now());
    }
  }

  const log = await ctx.getLog();
  await log.add(msgid('Folgeknoten erreicht'), true, `${peer.name} (${peer.url})`);

  let answer: NodeAnswer;
  try {
    answer = await callNode(target, 'apply', bundle, SEND_MS);
  } catch (err) {
    if (err instanceof NodeCallError) return fail(err.message, !err.unreachable);
    throw err;
  }
  if (!answer.ok) return fail(refusalText(answer, peer.name, ctx.ownNodeId), true);
  await log.add(msgid('Stand übertragen'), true, sizeLabel(bundle.length));

  // Der Folgeknoten wendet abgekoppelt an. Sein Neuladen kann die Verbindung
  // kurz kappen (wenn sie über sein HAProxy läuft): bis zur Frist weiterfragen.
  const deadline = Date.now() + APPLY_WAIT_MS;
  let applied: NodeReport['apply'] = null;
  let lastProblem = '';
  while (Date.now() < deadline) {
    await sleep(1500);
    try {
      const current = await askNode(target);
      if (current.apply && current.apply.seq === meta.seq && current.apply.state !== 'running') {
        applied = current.apply;
        break;
      }
    } catch (err) {
      lastProblem = err instanceof Error ? err.message : String(err);
    }
  }
  if (!applied) {
    return fail(`${peer.name} hat das Paket angenommen, meldet aber kein Ergebnis.${lastProblem ? ` ${lastProblem}` : ''}`, true);
  }
  for (const step of applied.steps) await log.add(step.label, step.ok, step.detail);
  if (applied.state !== 'success') {
    const failed = applied.steps.find((step) => !step.ok);
    const reason = applied.error ?? (failed ? [failed.label, failed.detail].filter(Boolean).join(': ') : 'ohne Grund');
    // Die Schritte stehen schon im Lauf: nur noch den Zustand festhalten.
    await updatePeer(peer.$id, { ...seen, lastCheckAt: now(), reachable: true, inSync: false, lastError: `${peer.name} hat den Stand nicht übernommen: ${reason}` }).catch(
      () => undefined
    );
    return { peer, result: 'failed', error: `${peer.name} hat den Stand nicht übernommen: ${reason}`, reported: true };
  }

  await updatePeer(peer.$id, { ...seen, lastCheckAt: now(), reachable: true, inSync: true, lastSyncAt: now(), lastError: null }).catch(
    () => undefined
  );
  return { peer, result: 'synced' };
}

interface RoundOptions {
  trigger: SyncTrigger;
  force: boolean;
  actor: SyncActor;
  /** Der Lauf, wenn ihn die Anfrage schon angelegt hat („Jetzt abgleichen"). */
  runId?: string;
}

async function round(options: RoundOptions): Promise<void> {
  const sync = await getSyncSettings();
  const peers = sync.role === 'primary' ? await listPeers() : [];
  if (peers.length === 0) {
    // Zwischen Knopf und Runde hat jemand die Rolle gewechselt oder den letzten Folgeknoten entfernt.
    if (options.runId) {
      await updateSyncRun(options.runId, {
        status: 'error',
        completedAt: new Date().toISOString(),
        error: msgid('Es gibt keinen Folgeknoten mehr, an den abgeglichen würde.'),
      }).catch(() => undefined);
    }
    return;
  }

  let packed: Promise<Packed> | null = null;
  let log: RunLog | null = options.runId ? new RunLog(options.runId) : null;
  const startedAt = new Date().toISOString();
  const ctx: RoundContext = {
    trigger: options.trigger,
    force: options.force,
    ownNodeId: sync.nodeId,
    getPacked: () => (packed ??= packState()),
    getLog: async () => {
      if (!log) {
        const run = await createSyncRun({
          direction: 'send',
          trigger: options.trigger,
          status: 'running',
          startedAt,
          completedAt: null,
          peers: peers.map((peer) => peer.name).join(', '),
          steps: '[]',
          error: null,
          triggeredBy: options.actor.userEmail,
        });
        log = new RunLog(run.$id);
      }
      return log;
    },
  };

  const outcomes: PeerOutcome[] = [];
  for (const peer of peers) {
    try {
      outcomes.push(await syncPeer(peer, ctx));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await (await ctx.getLog()).add(msgid('Abgleich mit dem Folgeknoten'), false, `${peer.name}: ${error}`);
      outcomes.push({ peer, result: 'failed', error, reported: true });
    }
  }

  const failures = outcomes.filter((outcome): outcome is Extract<PeerOutcome, { result: 'failed' }> => outcome.result === 'failed');
  const finished: RunLog | null = log;
  if (finished) {
    const summary = failures.length > 0 ? failures.map((failure) => failure.error).join(' ') : null;
    await updateSyncRun(finished.runId, {
      status: failures.length > 0 || finished.failed ? 'error' : 'success',
      completedAt: new Date().toISOString(),
      error: summary,
    }).catch(() => undefined);
    await logAudit({
      ...options.actor,
      action: failures.length > 0 ? 'sync_failed' : 'sync_completed',
      resource: 'sync',
      details: outcomes
        .map((outcome) => {
          if (outcome.result === 'failed') return `${outcome.peer.name}: ${outcome.error}`;
          if (outcome.result === 'synced') return `${outcome.peer.name}: Stand übernommen`;
          return `${outcome.peer.name}: unverändert`;
        })
        .join('; '),
    });
  }
  for (const failure of failures) {
    // Bei jeder Prüfung gemeldet, `notify` dämpft: je Folgeknoten eine Mail am
    // Tag, und hält der Ausfall an, am nächsten Tag eine Erinnerung.
    void notify({ type: 'sync_failed', peer: failure.peer.name, url: failure.peer.url, error: failure.error });
  }
}

async function runExclusive(options: RoundOptions): Promise<void> {
  const memory = state();
  memory.running = true;
  try {
    await round(options);
  } catch (err) {
    console.error('[abgleich] Runde gescheitert:', err instanceof Error ? err.message : err);
    if (options.runId) {
      await updateSyncRun(options.runId, {
        status: 'error',
        completedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      }).catch(() => undefined);
    }
  } finally {
    memory.running = false;
    // Was sich während der Runde geändert hat, sieht die nächste.
    if (memory.again) {
      memory.again = false;
      requestSyncSoon();
    }
  }
}

export function syncRunning(): boolean {
  return state().running;
}

/**
 * Nachsehen und übertragen, wo der Stand abweicht. Für den Anstoß nach einer
 * Änderung und die regelmäßige Prüfung. Wirft nie und tut auf einem Knoten,
 * der kein Hauptknoten ist, nichts.
 */
export async function checkPeers(trigger: 'change' | 'schedule'): Promise<void> {
  const memory = state();
  if (memory.running) {
    memory.again = true;
    return;
  }
  // Vor dem ersten `await`: zwei Anstöße zur selben Zeit ergeben eine Runde.
  memory.running = true;
  let primary = false;
  try {
    primary = (await getSyncSettings()).role === 'primary';
  } catch {
    // Ohne Datenbank gibt es nichts abzugleichen.
  }
  if (!primary) {
    memory.running = false;
    memory.again = false;
    return;
  }
  await runExclusive({ trigger, force: false, actor: systemActor() });
}

const DEBOUNCE_MS = 3000;

/** Nach einer Änderung: gleich, aber nicht sofort. Drei Vorgänge hintereinander sind ein Abgleich. */
export function requestSyncSoon(): void {
  const memory = state();
  if (memory.timer) clearTimeout(memory.timer);
  const timer = setTimeout(() => {
    memory.timer = null;
    void checkPeers('change');
  }, DEBOUNCE_MS);
  // Ein wartender Anstoß hält den Prozess nicht am Leben.
  timer.unref?.();
  memory.timer = timer;
}

/**
 * „Jetzt abgleichen": überträgt an jeden Folgeknoten, auch wenn er den Stand
 * schon trägt. Kehrt zurück, sobald der Lauf angelegt ist.
 */
export async function startManualSync(actor: SyncActor): Promise<{ runId: string }> {
  const sync = await getSyncSettings();
  if (sync.role !== 'primary') {
    throw new ApiError(msg('Abgeglichen wird vom Hauptknoten aus. Dieser Knoten ist keiner.'), 409);
  }
  const peers = await listPeers();
  if (peers.length === 0) throw new ApiError(msg('Es ist noch kein Folgeknoten eingetragen.'), 409);
  const memory = state();
  if (memory.running) throw new ApiError(msg('Es läuft schon ein Abgleich.'), 409);
  memory.running = true;

  let runId: string;
  try {
    const run = await createSyncRun({
      direction: 'send',
      trigger: 'manual',
      status: 'running',
      startedAt: new Date().toISOString(),
      completedAt: null,
      peers: peers.map((peer) => peer.name).join(', '),
      steps: '[]',
      error: null,
      triggeredBy: actor.userEmail,
    });
    runId = run.$id;
  } catch (err) {
    memory.running = false;
    throw err;
  }
  await logAudit({ ...actor, action: 'sync_started', resource: 'sync', details: `Abgleich an ${peers.map((peer) => peer.name).join(', ')}` });
  void runExclusive({ trigger: 'manual', force: true, actor, runId });
  return { runId };
}
