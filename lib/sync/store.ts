/**
 * Was der Abgleich in der Datenbank hält: die Rolle dieses Knotens, die
 * Gegenstellen eines Hauptknotens und die Läufe.
 *
 * Drei Collections statt einer Zeile: der Zustand einer Gegenstelle wird bei
 * jeder Prüfung geschrieben, während jemand in der Oberfläche eine andere
 * anlegt. In einer gemeinsamen Zeile überschriebe der eine den anderen.
 *
 * Der Kopplungsschlüssel liegt verschlüsselt hier (`lib/crypto.ts`), auf beiden
 * Seiten: mit ihm wird ver- und entschlüsselt, ein Hash reichte nicht. Die
 * Oberfläche erfährt nur, ob einer gesetzt ist.
 */

import { randomBytes } from 'node:crypto';
import { createDocument, deleteDocument, deleteWhere, getDocument, getSingleton, listAll, listDocuments, updateDocument, Query } from '../db';
import { decrypt, encrypt } from '../crypto';
import { msgid } from '../i18n/translate';
import { COLLECTIONS, type DbDoc, type HaproxyStep, type RunStatus } from '../types';
import type { CrowdsecOutcome } from './adapt';
import type { SyncDirection, SyncRole, SyncTrigger, SyncWarning } from './types';

const SETTINGS_ID = 'main';

/** Der zuletzt übernommene Stand eines Folgeknotens. */
export interface AppliedState {
  /** Fingerabdruck des Pakets, wie der Hauptknoten ihn nennt. */
  fingerprint: string;
  seq: number;
  at: string;
  /** Womit das Paket an diesen Knoten angepasst wurde (`localVariant`). */
  variant: string;
  /** Fingerabdruck der Dateien hier, unmittelbar nach dem Abgleich. */
  localFingerprint: string;
  crowdsec: CrowdsecOutcome;
  /** Fingerabdruck des übernommenen Datenteils, wie der Hauptknoten ihn nennt. Fehlt oder `null`: keiner übernommen. */
  dataFingerprint?: string | null;
  /** Fingerabdruck der Daten hier, unmittelbar nach dem Abgleich. */
  localDataFingerprint?: string | null;
  /** Fingerabdruck des übernommenen Stands von CrowdSec, wie der Hauptknoten ihn nennt. */
  crowdsecFingerprint?: string | null;
}

/** Ein Abgleich, den dieser Knoten abgelehnt hat, für den Hinweis auf der Seite. */
export interface Rejection {
  at: string;
  nodeId: string;
  name: string;
  /** `not_replica` oder `other_primary`. */
  code: string;
}

export interface SyncSettings extends DbDoc {
  role: SyncRole;
  /** Kennung dieses Knotens gegenüber anderen. Entsteht beim ersten Lesen, und neu mit jedem Kopplungsschlüssel. */
  nodeId: string;
  /** Nur Folgeknoten: der Kopplungsschlüssel, verschlüsselt. */
  pairingKey: string | null;
  pairingKeyCreatedAt: string | null;
  /** Nur Folgeknoten: der Hauptknoten, von dem zuerst ein Stand kam. Von einem anderen wird nichts angenommen. */
  primary: { nodeId: string; name: string } | null;
  applied: AppliedState | null;
  rejected: Rejection | null;
}

type SettingsData = Omit<SyncSettings, keyof DbDoc>;

export function newNodeId(): string {
  return randomBytes(16).toString('hex');
}

function defaults(): SettingsData {
  return { role: 'single', nodeId: newNodeId(), pairingKey: null, pairingKeyCreatedAt: null, primary: null, applied: null, rejected: null };
}

export async function getSyncSettings(): Promise<SyncSettings> {
  const row = await getSingleton<SyncSettings>(COLLECTIONS.SYNC_SETTINGS, SETTINGS_ID, defaults());
  // Die Vorgaben hinter der Zeile, bis auf die Kennung: die steht in der Zeile, sobald es sie gibt.
  return { ...defaults(), ...row };
}

export async function updateSyncSettings(patch: Partial<SettingsData>): Promise<SyncSettings> {
  await getSyncSettings();
  await updateDocument<SyncSettings>(COLLECTIONS.SYNC_SETTINGS, SETTINGS_ID, patch);
  return getSyncSettings();
}

export function sealKey(key: string): string {
  return encrypt(key);
}

/** Der Klartext eines gespeicherten Schlüssels, oder `null`, wenn er sich nicht lesen lässt (anderer `encryptionKey`). */
export function openKey(stored: string | null): string | null {
  if (!stored) return null;
  try {
    return decrypt(stored);
  } catch {
    return null;
  }
}

/* ── Gegenstellen (nur Hauptknoten) ── */

export interface SyncPeer extends DbDoc {
  name: string;
  /** `http://10.0.0.2:7080`, ohne Pfad und ohne Schrägstrich am Ende. */
  url: string;
  /** Der Kopplungsschlüssel des Folgeknotens, verschlüsselt. */
  key: string;
  nodeId: string | null;
  addedAt: string;
  /** Wann zuletzt nachgesehen wurde, und ob der Knoten dabei geantwortet hat. `null`: noch nie. */
  lastCheckAt: string | null;
  reachable: boolean | null;
  /** Ob er den Stand von hier trägt. `null` heißt unbekannt, nicht „gleich". */
  inSync: boolean | null;
  /** Wann zuletzt ein Stand übernommen wurde. */
  lastSyncAt: string | null;
  /** Der Grund, wenn Prüfung oder Abgleich zuletzt gescheitert sind. Deutscher Text mit Werten. */
  lastError: string | null;
  /** Was auffiel, ohne den Abgleich zu verhindern. */
  warnings: SyncWarning[];
  hapmVersion: string | null;
  haproxyVersion: string | null;
}

export type PeerData = Omit<SyncPeer, keyof DbDoc>;

export function listPeers(): Promise<SyncPeer[]> {
  return listAll<SyncPeer>(COLLECTIONS.SYNC_PEERS);
}

export function getPeer(id: string): Promise<SyncPeer> {
  return getDocument<SyncPeer>(COLLECTIONS.SYNC_PEERS, id);
}

export function createPeer(data: PeerData): Promise<SyncPeer> {
  return createDocument<SyncPeer>(COLLECTIONS.SYNC_PEERS, data);
}

export async function updatePeer(id: string, patch: Partial<PeerData>): Promise<void> {
  await updateDocument<SyncPeer>(COLLECTIONS.SYNC_PEERS, id, patch);
}

export async function deletePeer(id: string): Promise<void> {
  await deleteDocument(COLLECTIONS.SYNC_PEERS, id);
}

/* ── Läufe ── */

export interface SyncRun extends DbDoc {
  /** `send`: von hier an die Folgeknoten. `receive`: ein Stand, der hier ankam. */
  direction: SyncDirection;
  trigger: SyncTrigger;
  status: RunStatus;
  startedAt: string;
  completedAt: string | null;
  /** Die Namen der Gegenstellen, mit Komma getrennt. */
  peers: string;
  /** JSON-Text von `HaproxyStep[]`. */
  steps: string | null;
  error: string | null;
  triggeredBy: string | null;
}

export type RunData = Omit<SyncRun, keyof DbDoc>;

export function createSyncRun(data: RunData): Promise<SyncRun> {
  return createDocument<SyncRun>(COLLECTIONS.SYNC_RUNS, data);
}

export async function updateSyncRun(id: string, patch: Partial<RunData>): Promise<void> {
  await updateDocument<SyncRun>(COLLECTIONS.SYNC_RUNS, id, patch);
}

export function getSyncRunRow(id: string): Promise<SyncRun> {
  return getDocument<SyncRun>(COLLECTIONS.SYNC_RUNS, id);
}

export function listSyncRuns(limit = 20): Promise<SyncRun[]> {
  return listDocuments<SyncRun>(COLLECTIONS.SYNC_RUNS, [Query.orderDesc('startedAt'), Query.limit(limit)]);
}

export function pruneSyncRuns(olderThanIso: string): Promise<number> {
  return deleteWhere(COLLECTIONS.SYNC_RUNS, [Query.lessThan('startedAt', olderThanIso)]);
}

export const SYNC_INTERRUPTED = msgid('HAPM wurde während des Abgleichs neu gestartet.');

/** Beim Start: ein offener Lauf ist mit dem vorigen Prozess gestorben. */
export async function closeOpenSyncRuns(): Promise<number> {
  const open = await listDocuments<SyncRun>(COLLECTIONS.SYNC_RUNS, [Query.equal('status', 'running'), Query.limit(50)]);
  for (const run of open) {
    await updateSyncRun(run.$id, { status: 'error', completedAt: new Date().toISOString(), error: SYNC_INTERRUPTED });
  }
  return open.length;
}

/** Die Schritte eines Laufs, während er läuft: jede Zeile geht sofort in die Datenbank. */
export class RunLog {
  readonly steps: HaproxyStep[] = [];

  constructor(readonly runId: string) {}

  async add(label: string, ok: boolean, detail?: string): Promise<void> {
    this.steps.push({ label, ok, ...(detail ? { detail: detail.slice(0, 1500) } : {}) });
    await updateSyncRun(this.runId, { steps: JSON.stringify(this.steps) }).catch(() => undefined);
  }

  get failed(): HaproxyStep | null {
    return this.steps.find((step) => !step.ok) ?? null;
  }
}
