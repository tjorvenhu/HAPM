/**
 * Was dieser Knoten über sich weiß: die Angaben, an denen der Abgleich
 * vergleicht (Fassungen, CrowdSec, Art der Installation), und die Auskunft, die
 * er einer Gegenstelle gibt.
 */

import pkg from '../../package.json';
import { localServer } from '../helpers';
import { getSettings } from '../settings';
import { probeProxy } from '../haproxy/provision';
import { crowdsecInstalled, spoaAddress } from '../crowdsec/paths';
import { localVariant, type LocalNode } from './adapt';
import { ROOT_DIRS, localFingerprint } from './bundle';
import { localDataFingerprint } from './data-collect';
import { getSyncSettings, type SyncSettings } from './store';
import { SYNC_PROTOCOL, type ApplyState, type NodeReport } from './types';

export const HAPM_VERSION: string = pkg.version;

export function localNode(): LocalNode {
  return { crowdsec: crowdsecInstalled(), spoaAddress: spoaAddress() };
}

export function nodeName(): string {
  return localServer().name;
}

const versionCache = globalThis as unknown as { __hapmSyncHaproxyVersion?: { at: number; value: string } };
const VERSION_CACHE_MS = 60_000;

/**
 * Die Fassung von HAProxy. `null` heißt unbekannt: der Container antwortet
 * gerade nicht. Eine Minute gemerkt: während ein Folgeknoten anwendet, fragt
 * der Hauptknoten alle anderthalb Sekunden nach der Auskunft, und die Fassung
 * ändert sich nur mit einem Update.
 */
export async function haproxyVersion(): Promise<string | null> {
  const cached = versionCache.__hapmSyncHaproxyVersion;
  if (cached && Date.now() - cached.at < VERSION_CACHE_MS) return cached.value;
  try {
    const value = (await probeProxy(localServer())).version;
    if (value) versionCache.__hapmSyncHaproxyVersion = { at: Date.now(), value };
    return value;
  } catch {
    return null;
  }
}

/** Ob die Dateien noch so liegen wie nach dem letzten Abgleich. `null`: nicht zu sagen. */
export function filesIntact(settings: Pick<SyncSettings, 'applied'>): boolean | null {
  if (!settings.applied) return null;
  try {
    return localFingerprint(ROOT_DIRS) === settings.applied.localFingerprint;
  } catch {
    return null;
  }
}

/**
 * Ob Konten, Einstellungen, Zonen und API-Keys noch so in der Datenbank stehen
 * wie nach dem letzten Abgleich. `null`: nicht zu sagen, oder es wurde noch
 * kein Datenteil übernommen.
 */
export async function dataIntact(settings: Pick<SyncSettings, 'applied'>): Promise<boolean | null> {
  const expected = settings.applied?.localDataFingerprint;
  if (!expected) return null;
  try {
    return (await localDataFingerprint()) === expected;
  } catch {
    return null;
  }
}

export async function nodeReport(apply: ApplyState | null): Promise<NodeReport> {
  const [sync, settings, version] = await Promise.all([getSyncSettings(), getSettings(), haproxyVersion()]);
  const replica = sync.role === 'replica';
  return {
    protocol: SYNC_PROTOCOL,
    nodeId: sync.nodeId,
    name: nodeName(),
    role: sync.role,
    hapmVersion: HAPM_VERSION,
    haproxyVersion: version,
    crowdsec: crowdsecInstalled(),
    exposure: settings.exposure,
    primary: sync.primary,
    applied: sync.applied
      ? {
          fingerprint: sync.applied.fingerprint,
          seq: sync.applied.seq,
          at: sync.applied.at,
          variant: sync.applied.variant,
          data: sync.applied.dataFingerprint ?? null,
          crowdsec: sync.applied.crowdsecFingerprint ?? null,
        }
      : null,
    variant: localVariant(localNode()),
    // Nur ein Folgeknoten hat einen Stand, der von woanders kommt.
    intact: replica ? filesIntact(sync) : null,
    dataIntact: replica ? await dataIntact(sync) : null,
    apply,
  };
}
