/**
 * Was die Seite „Abgleich", die interne API (`/api/internal/sync`) und der
 * MCP-Server gemeinsam tun. Jede schreibende Funktion schreibt ihr Protokoll
 * selbst, damit es keinen Weg ohne gibt.
 *
 * Über einen API-Key geht nur Lesen und „Jetzt abgleichen". Rolle,
 * Kopplungsschlüssel und Gegenstellen gibt es nur in der Oberfläche: der
 * Schlüssel ist ein Geheimnis (docs/mcp.md, „Was es bewusst nicht gibt"), und
 * wer die Rolle umstellt, entscheidet, welcher Knoten den anderen überschreibt.
 */

import { ApiError } from '../api';
import { logAudit } from '../audit';
import { msg } from '../i18n/translate';
import { parseSteps, stepsAsLog } from '../haproxy/runner';
import type { HaproxyStep } from '../types';
import { currentApply } from './apply';
import { generatePairingKey, isPairingKey } from './envelope';
import { HAPM_VERSION, filesIntact, localNode, nodeName } from './node';
import { localVariant } from './adapt';
import { refusalOf } from './compare';
import { NodeCallError, askNode, requestSyncSoon, startManualSync, syncRunning, type SyncActor } from './send';
import {
  createPeer,
  deletePeer,
  getPeer,
  getSyncRunRow,
  getSyncSettings,
  listPeers,
  listSyncRuns,
  newNodeId,
  sealKey,
  updateSyncSettings,
  type SyncPeer,
  type SyncRun,
} from './store';
import { SYNC_ROLE_LABELS, isSyncRole, type SyncRole } from './types';

function peerView(peer: SyncPeer) {
  // Ohne den Schlüssel: er verlässt die Datenbank nur zum Verschlüsseln einer Anfrage.
  const { key: _key, ...rest } = peer;
  void _key;
  return rest;
}

export type SyncPeerView = ReturnType<typeof peerView>;

function runView(run: SyncRun) {
  return { ...run, steps: JSON.parse(run.steps ?? '[]') as HaproxyStep[] };
}

export type SyncRunView = ReturnType<typeof runView>;

export async function syncOverview() {
  const [settings, peers, runs] = await Promise.all([getSyncSettings(), listPeers(), listSyncRuns(15)]);
  const replica = settings.role === 'replica';
  const apply = currentApply();
  return {
    role: settings.role,
    node: { id: settings.nodeId, name: nodeName(), hapmVersion: HAPM_VERSION },
    running: syncRunning() || apply?.state === 'running' || runs.some((run) => run.status === 'running'),
    /** Was dieser Knoten als Folgeknoten weiß. Der Schlüssel selbst geht nie hinaus. */
    replica: {
      keySet: Boolean(settings.pairingKey),
      keyCreatedAt: settings.pairingKeyCreatedAt,
      primary: settings.primary ? { name: settings.primary.name } : null,
      applied: settings.applied ? { at: settings.applied.at, crowdsec: settings.applied.crowdsec } : null,
      /** `false`: hier wurden Dateien geändert, seit der Stand kam. `null`: nicht zu sagen. */
      intact: replica ? filesIntact(settings) : null,
      /** Dieser Knoten würde ein Paket inzwischen anders anpassen als beim letzten Mal. */
      adaptationChanged: replica && settings.applied !== null && settings.applied.variant !== localVariant(localNode()),
      rejected: settings.rejected,
    },
    /** Nur ein Hauptknoten gleicht ab. Auf den anderen bleiben eingetragene Gegenstellen liegen und ruhen. */
    peers: peers.map(peerView).sort((a, b) => a.name.localeCompare(b.name)),
    runs: runs.map(runView),
  };
}

export type SyncOverview = Awaited<ReturnType<typeof syncOverview>>;

/** Die Rolle umstellen. Sonst ändert sich nichts: Schlüssel und Gegenstellen bleiben liegen. */
export async function changeSyncRole(body: Record<string, unknown>, actor: SyncActor): Promise<SyncOverview> {
  if (!isSyncRole(body.role)) {
    throw new ApiError(msg('Erwartet wird role: single, primary oder replica.'));
  }
  const role: SyncRole = body.role;
  const current = await getSyncSettings();
  if (current.role === role) return syncOverview();
  if (syncRunning() || currentApply()?.state === 'running') {
    throw new ApiError(msg('Es läuft gerade ein Abgleich. Die Rolle lässt sich danach umstellen.'), 409);
  }
  // Ein abgelehnter Abgleich gehört zur alten Rolle: mit der neuen ist er vielleicht gerade behoben.
  await updateSyncSettings({ role, rejected: null });
  await logAudit({
    ...actor,
    action: 'sync_role_changed',
    resource: 'sync',
    details: `Rolle: ${SYNC_ROLE_LABELS[current.role]} → ${SYNC_ROLE_LABELS[role]}`,
  });
  // Ein neuer Hauptknoten mit schon eingetragenen Folgeknoten gleicht gleich ab.
  if (role === 'primary') requestSyncSoon();
  return syncOverview();
}

/**
 * Einen neuen Kopplungsschlüssel erzeugen. Der Klartext geht genau einmal
 * hinaus, in dieser Antwort.
 *
 * Mit dem Schlüssel beginnt die Kopplung neu: die Kennung des Knotens wechselt,
 * die Bindung an den bisherigen Hauptknoten und der gemerkte Stand fallen weg.
 * Der bisherige Schlüssel gilt ab sofort nicht mehr.
 */
export async function createPairingKey(actor: SyncActor): Promise<{ key: string; overview: SyncOverview }> {
  const settings = await getSyncSettings();
  if (settings.role !== 'replica') {
    throw new ApiError(msg('Einen Kopplungsschlüssel erzeugt nur ein Folgeknoten. Bitte zuerst die Rolle umstellen.'), 409);
  }
  if (currentApply()?.state === 'running') {
    throw new ApiError(msg('Es läuft gerade ein Abgleich. Ein neuer Schlüssel lässt sich danach erzeugen.'), 409);
  }
  const key = generatePairingKey();
  await updateSyncSettings({
    pairingKey: sealKey(key),
    pairingKeyCreatedAt: new Date().toISOString(),
    nodeId: newNodeId(),
    primary: null,
    applied: null,
    rejected: null,
  });
  await logAudit({
    ...actor,
    action: 'sync_key_created',
    resource: 'sync',
    details: settings.pairingKey ? 'Neuer Kopplungsschlüssel, der bisherige gilt nicht mehr.' : 'Kopplungsschlüssel erzeugt.',
  });
  return { key, overview: await syncOverview() };
}

/**
 * Die Adresse eines Folgeknotens, wie sie gespeichert wird: Schema, Name oder
 * Adresse, Port. Ohne Pfad, ohne Zugangsdaten.
 *
 * `http` ist erlaubt und oft der richtige Weg (`http://10.0.0.2:7080`): der
 * Schutz der Übertragung hängt nicht an der Leitung (`envelope.ts`).
 */
export function normalizePeerUrl(input: unknown): string {
  const raw = String(input ?? '').trim();
  if (!/^https?:\/\//i.test(raw)) {
    throw new ApiError(msg('Die Adresse beginnt mit http:// oder https://, zum Beispiel http://10.0.0.2:7080.'));
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError(msg('Das ist keine gültige Adresse.'));
  }
  if (url.username || url.password) throw new ApiError(msg('Die Adresse darf keine Zugangsdaten enthalten.'));
  if (url.pathname !== '/' || url.search || url.hash || /[?#]/.test(raw)) {
    throw new ApiError(msg('Die Adresse besteht nur aus Schema, Name und Port, ohne Pfad dahinter.'));
  }
  return url.origin;
}

function cleanName(value: unknown): string {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 60);
}

/**
 * Einen Folgeknoten eintragen. Gespeichert wird erst, wenn er mit diesem
 * Schlüssel geantwortet hat und als Folgeknoten eingerichtet ist: eine falsche
 * Adresse oder ein falscher Schlüssel soll hier auffallen und nicht beim
 * ersten Abgleich.
 */
export async function addSyncPeer(body: Record<string, unknown>, actor: SyncActor): Promise<SyncOverview> {
  const settings = await getSyncSettings();
  if (settings.role !== 'primary') {
    throw new ApiError(msg('Folgeknoten trägt nur ein Hauptknoten ein. Bitte zuerst die Rolle umstellen.'), 409);
  }
  const url = normalizePeerUrl(body.url);
  const key = String(body.key ?? '').trim();
  if (!isPairingKey(key)) {
    throw new ApiError(msg('Das ist kein Kopplungsschlüssel. Er beginnt mit hapmsync_ und wird auf dem Folgeknoten erzeugt.'));
  }
  const existing = await listPeers();
  if (existing.some((peer) => peer.url === url)) {
    throw new ApiError(msg('Unter {url} ist schon ein Folgeknoten eingetragen.', { url }), 409);
  }

  let report;
  try {
    report = await askNode({ url, key });
  } catch (err) {
    if (err instanceof NodeCallError) throw new ApiError(msg('Die Kopplung ist nicht zustande gekommen: {detail}', { detail: err.message }), 409);
    throw err;
  }
  const refusal = refusalOf(report, settings.nodeId);
  if (refusal) throw new ApiError(msg('Die Kopplung ist nicht zustande gekommen: {detail}', { detail: refusal }), 409);
  if (existing.some((peer) => peer.nodeId === report.nodeId)) {
    throw new ApiError(msg('{name} ist schon als Folgeknoten eingetragen.', { name: report.name }), 409);
  }

  const name = cleanName(body.name) || report.name;
  await createPeer({
    name,
    url,
    key: sealKey(key),
    nodeId: report.nodeId,
    addedAt: new Date().toISOString(),
    lastCheckAt: new Date().toISOString(),
    reachable: true,
    inSync: null,
    lastSyncAt: null,
    lastError: null,
    warnings: [],
    hapmVersion: report.hapmVersion,
    haproxyVersion: report.haproxyVersion,
  });
  await logAudit({ ...actor, action: 'sync_peer_added', resource: 'sync', details: `Folgeknoten ${name} (${url})` });
  // Der erste Stand geht gleich hinüber.
  requestSyncSoon();
  return syncOverview();
}

/** Einen Folgeknoten austragen. Er behält seinen letzten Stand, es kommt nur keiner mehr nach. */
export async function removeSyncPeer(id: string, actor: SyncActor): Promise<SyncOverview> {
  let peer: SyncPeer;
  try {
    peer = await getPeer(id);
  } catch {
    throw new ApiError(msg('Diesen Folgeknoten gibt es nicht.'), 404);
  }
  await deletePeer(id);
  await logAudit({ ...actor, action: 'sync_peer_removed', resource: 'sync', details: `Folgeknoten ${peer.name} (${peer.url})` });
  return syncOverview();
}

/** „Jetzt abgleichen". Läuft abgekoppelt, die Antwort trägt den Lauf. */
export async function startSyncRun(actor: SyncActor): Promise<{ runId: string }> {
  return startManualSync(actor);
}

/** Ein Lauf des Abgleichs, in der Form von `getRun`. */
export async function getSyncRun(id: string, t: (text: string) => string) {
  let run: SyncRun;
  try {
    run = await getSyncRunRow(id);
  } catch {
    throw new ApiError(msg('Diesen Lauf des Abgleichs gibt es nicht.'), 404);
  }
  const steps = parseSteps(run.steps);
  return {
    id: run.$id,
    direction: run.direction,
    trigger: run.trigger,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    peers: run.peers,
    triggeredBy: run.triggeredBy,
    error: run.error === null ? null : t(run.error),
    steps,
    log: stepsAsLog(steps, t),
  };
}
