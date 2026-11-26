/**
 * Den Datenteil eines Pakets auf einem Folgeknoten einsetzen: Einstellungen,
 * Konten, DNS-Zonen, API-Keys und CrowdSec (`data.ts`).
 *
 * ── Ein Abbild, kein Zusammenführen ──
 *
 * Wie bei den Dateien: was der Hauptknoten nicht nennt, gibt es hier danach
 * nicht mehr. Das gilt auch für die Konten. Wer am Folgeknoten angemeldet war
 * und dessen Konto der Hauptknoten nicht kennt, ist nach dem ersten Abgleich
 * abgemeldet und meldet sich mit einem Konto des Hauptknotens neu an.
 *
 * ── Jeder Teil für sich ──
 *
 * Scheitert ein Teil, laufen die übrigen trotzdem: eine Zone mit unlesbarem
 * Zugang soll nicht verhindern, dass ein gesperrtes Konto gesperrt wird. Der
 * Lauf gilt dann als gescheitert, und der Hauptknoten schickt bei der nächsten
 * Prüfung erneut.
 *
 * ── Nur schreiben, was abweicht ──
 *
 * Ein Abgleich überträgt immer alles. Eine Zeile, die schon so dasteht, wird
 * nicht angefasst: sonst bekäme jedes Geheimnis bei jedem Abgleich ein neues
 * Chiffrat und jede Zeile einen neuen Zeitstempel.
 */

import { createDocument, deleteDocument, listAll, updateDocument } from '../db';
import { replaceAccountRows } from '../db/account-rows';
import { decrypt, encrypt } from '../crypto';
import { systemActor } from '../audit';
import { crowdsecInstalled } from '../crowdsec/paths';
import { msgid } from '../i18n/translate';
import { getSettings, settingsPatch, type SettingsInput } from '../settings';
import {
  COLLECTIONS,
  NOTIFICATION_EVENT_TYPES,
  SETTINGS_ID,
  type DnsZone,
  type NotificationEventType,
  type ServiceToken,
  type Settings,
  type TwoFactorConfig,
} from '../types';
import { localDataFingerprint } from './data-collect';
import { canonical, type SyncData, type SyncDnsZone, type SyncServiceToken, type SyncTwoFactor } from './data';
import type { SyncStep } from './types';

function open(stored: string | null | undefined): string | null {
  if (!stored) return null;
  try {
    return decrypt(stored);
  } catch {
    return null;
  }
}

/** Ein Geheimnis für die Datenbank dieses Knotens. Eines, das der Hauptknoten nicht lesen konnte, bleibt hier ebenso unlesbar. */
function seal(plain: string | null): string {
  return plain === null ? '' : encrypt(plain);
}

function count(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

/** Was ein Teil ergab: der Satz für den Lauf, und ob sich hier etwas geändert hat. */
interface PartResult {
  detail: string;
  changed: boolean;
}

async function applySettings(data: SyncData['settings']): Promise<PartResult> {
  const current = await getSettings();
  const { smtpPass, notifyEvents, ...fields } = data;
  const input: SettingsInput = {
    ...fields,
    // Ein Ereignis, das nur die Fassung des Hauptknotens kennt, hat hier keinen Schalter.
    notifyEvents: Object.fromEntries(
      Object.entries(notifyEvents).filter(([type]) => (NOTIFICATION_EVENT_TYPES as readonly string[]).includes(type))
    ) as Partial<Record<NotificationEventType, boolean>>,
  };
  if (smtpPass !== open(current.smtpPass)) input.smtpPass = smtpPass;

  // Dieselbe Prüfung wie für eine Eingabe in der Oberfläche: dem Paket wird nicht getraut.
  const patch = settingsPatch(input, current, encrypt) as Partial<Settings>;
  const changed = (Object.keys(patch) as (keyof Settings)[]).filter((key) => canonical(patch[key]) !== canonical(current[key]));
  if (changed.length === 0) return { detail: 'unverändert', changed: false };
  // Nicht über `updateSettings`: das löschte beim Wechsel der Adresse alle
  // Passkeys, und die kommen im selben Paket vom Hauptknoten.
  await updateDocument<Settings>(COLLECTIONS.SETTINGS, SETTINGS_ID, Object.fromEntries(changed.map((key) => [key, patch[key]])));
  return { detail: `${count(changed.length, 'Einstellung', 'Einstellungen')} geändert`, changed: true };
}

async function applyTwoFactor(wanted: readonly SyncTwoFactor[]): Promise<number> {
  const local = await listAll<TwoFactorConfig>(COLLECTIONS.TWO_FACTOR);
  const byUser = new Map(wanted.map((row) => [row.userId, row]));
  const seen = new Set<string>();
  let changes = 0;

  for (const row of local) {
    const want = byUser.get(row.userId);
    if (!want || seen.has(row.userId)) {
      await deleteDocument(COLLECTIONS.TWO_FACTOR, row.$id);
      changes++;
      continue;
    }
    seen.add(row.userId);
    const sameSecret = open(row.secret) === want.secret;
    const same =
      sameSecret &&
      row.enabled === want.enabled &&
      canonical([...(row.recoveryCodes ?? [])].sort()) === canonical([...want.recoveryCodes].sort()) &&
      (row.recoveryCodesCreatedAt ?? null) === want.recoveryCodesCreatedAt;
    if (same) continue;
    await updateDocument<TwoFactorConfig>(COLLECTIONS.TWO_FACTOR, row.$id, {
      ...(sameSecret ? {} : { secret: seal(want.secret), lastTotpStep: null }),
      enabled: want.enabled,
      recoveryCodes: want.recoveryCodes,
      recoveryCodesCreatedAt: want.recoveryCodesCreatedAt,
    });
    changes++;
  }
  for (const want of wanted) {
    if (seen.has(want.userId)) continue;
    await createDocument<TwoFactorConfig>(COLLECTIONS.TWO_FACTOR, {
      userId: want.userId,
      secret: seal(want.secret),
      enabled: want.enabled,
      recoveryCodes: want.recoveryCodes,
      recoveryCodesCreatedAt: want.recoveryCodesCreatedAt,
      lastTotpStep: null,
    });
    changes++;
  }
  return changes;
}

async function applyAccounts(accounts: SyncData['accounts']): Promise<PartResult> {
  const change = await replaceAccountRows(accounts);
  const twoFactor = await applyTwoFactor(accounts.twoFactor);
  for (const userId of change.removed) await deleteDocument(COLLECTIONS.USER_STATE, userId).catch(() => undefined);
  const parts = [count(accounts.users.length, 'Konto', 'Konten')];
  if (change.added.length > 0) parts.push(`${change.added.length} neu`);
  if (change.removed.length > 0) parts.push(`${change.removed.length} entfernt`);
  if (change.passwordChanged.length > 0) parts.push(`${count(change.passwordChanged.length, 'Passwort', 'Passwörter')} geändert`);
  if (twoFactor > 0) parts.push(`${count(twoFactor, 'zweiter Faktor', 'zweite Faktoren')} geändert`);
  return { detail: parts.join(', '), changed: parts.length > 1 };
}

async function applyZones(wanted: readonly SyncDnsZone[]): Promise<PartResult> {
  const local = await listAll<DnsZone>(COLLECTIONS.DNS_ZONES);
  const byId = new Map(wanted.map((zone) => [zone.id, zone]));
  let changes = 0;
  // Erst entfernen: eine Domain steht nur einmal da, auch wenn ihre Zeile hier eine andere Kennung trug.
  for (const row of local) {
    if (byId.has(row.$id)) continue;
    await deleteDocument(COLLECTIONS.DNS_ZONES, row.$id);
    changes++;
  }
  const kept = new Map(local.filter((row) => byId.has(row.$id)).map((row) => [row.$id, row]));
  for (const zone of wanted) {
    const row = kept.get(zone.id);
    const provider = (zone.provider ?? undefined) as DnsZone['provider'];
    if (!row) {
      await createDocument<DnsZone>(
        COLLECTIONS.DNS_ZONES,
        { ...(provider ? { provider } : {}), name: zone.name, zoneId: zone.zoneId, apiToken: seal(zone.access), status: 'ok', lastCheckedAt: null, lastError: null },
        zone.id
      );
      changes++;
      continue;
    }
    const sameAccess = open(row.apiToken) === zone.access;
    if (sameAccess && (row.provider ?? null) === zone.provider && row.name === zone.name && row.zoneId === zone.zoneId) continue;
    await updateDocument<DnsZone>(COLLECTIONS.DNS_ZONES, row.$id, {
      ...(provider ? { provider } : {}),
      name: zone.name,
      zoneId: zone.zoneId,
      // Mit einem neuen Zugang sagt der alte Zustand der Zone nichts mehr.
      ...(sameAccess ? {} : { apiToken: seal(zone.access), status: 'ok', lastCheckedAt: null, lastError: null }),
    });
    changes++;
  }
  const zones = count(wanted.length, 'Zone', 'Zonen');
  return { detail: changes === 0 ? `${zones}, unverändert` : `${zones}, ${changes} geändert`, changed: changes > 0 };
}

const TOKEN_FIELDS = ['name', 'tokenHash', 'prefix', 'description', 'createdBy', 'revokedAt', 'scopes', 'areas', 'allowedIps'] as const;

async function applyTokens(wanted: readonly SyncServiceToken[]): Promise<PartResult> {
  const local = await listAll<ServiceToken>(COLLECTIONS.SERVICE_TOKENS);
  const byId = new Map(wanted.map((token) => [token.id, token]));
  let changes = 0;
  for (const row of local) {
    if (byId.has(row.$id)) continue;
    await deleteDocument(COLLECTIONS.SERVICE_TOKENS, row.$id);
    changes++;
  }
  const kept = new Map(local.filter((row) => byId.has(row.$id)).map((row) => [row.$id, row]));
  for (const token of wanted) {
    const fields = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, token[field]])) as Pick<ServiceToken, (typeof TOKEN_FIELDS)[number]>;
    const row = kept.get(token.id);
    if (!row) {
      // Wann und von wo ein Key benutzt wurde, zählt jeder Knoten selbst.
      await createDocument<ServiceToken>(COLLECTIONS.SERVICE_TOKENS, { ...fields, lastUsedAt: null, lastUsedIp: null }, token.id);
      changes++;
      continue;
    }
    if (TOKEN_FIELDS.every((field) => (row[field] ?? null) === token[field])) continue;
    await updateDocument<ServiceToken>(COLLECTIONS.SERVICE_TOKENS, row.$id, fields);
    changes++;
  }
  const keys = count(wanted.length, 'API-Key', 'API-Keys');
  return { detail: changes === 0 ? `${keys}, unverändert` : `${keys}, ${changes} geändert`, changed: changes > 0 };
}

export interface DataApplyResult {
  ok: boolean;
  /** Ob alles aus der Datenbank übernommen ist (ohne CrowdSec). */
  dbOk: boolean;
  steps: SyncStep[];
  /**
   * Was sich hier geändert hat, je Teil ein Satz. Für das Protokoll: ein Konto,
   * das der Abgleich angelegt oder entfernt hat, soll dort nachzulesen sein.
   */
  changes: string[];
  /** Fingerabdruck der Daten hier nach dem Lauf. `null`, wenn er nicht zu lesen war. */
  localFingerprint: string | null;
  /**
   * `true`: CrowdSec trägt den Stand des Pakets, oder es gibt hier keines, an
   * dem etwas zu tun wäre. `false`: gescheitert. `null`: das Paket nennt
   * CrowdSec nicht, es bleibt, wie es war.
   */
  crowdsec: boolean | null;
}

export async function applyData(data: SyncData, onStep?: (step: SyncStep) => void | Promise<void>): Promise<DataApplyResult> {
  const steps: SyncStep[] = [];
  const push = async (label: string, ok: boolean, detail?: string) => {
    const step: SyncStep = { label, ok, ...(detail ? { detail: detail.slice(0, 1500) } : {}) };
    steps.push(step);
    try {
      await onStep?.(step);
    } catch {
      // Wer mitliest, hält das Anwenden nicht auf.
    }
  };
  const changes: string[] = [];
  const part = async (name: string, done: string, failed: string, work: () => Promise<PartResult>): Promise<boolean> => {
    try {
      const result = await work();
      if (result.changed) changes.push(`${name}: ${result.detail}`);
      await push(done, true, result.detail);
      return true;
    } catch (err) {
      await push(failed, false, err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  // Die Einstellungen zuerst: an der Adresse von HAPM hängen die Passkeys der Konten.
  const results = [
    await part('Einstellungen', msgid('Einstellungen übernommen'), msgid('Einstellungen übernehmen'), () => applySettings(data.settings)),
    await part('Konten', msgid('Konten übernommen'), msgid('Konten übernehmen'), () => applyAccounts(data.accounts)),
    await part('DNS-Zonen', msgid('DNS-Zonen übernommen'), msgid('DNS-Zonen übernehmen'), () => applyZones(data.dnsZones)),
    await part('API-Keys', msgid('API-Keys übernommen'), msgid('API-Keys übernehmen'), () => applyTokens(data.serviceTokens)),
  ];

  let crowdsec: boolean | null = null;
  if (data.crowdsec !== null) {
    const wanted = data.crowdsec;
    if (!crowdsecInstalled()) {
      await push(
        msgid('CrowdSec ausgelassen'),
        true,
        msgid('CrowdSec ist auf diesem Knoten nicht eingeschaltet. Sperren, Freigaben und Regeln wurden nicht übernommen.')
      );
      crowdsec = true;
    } else {
      crowdsec = await part('CrowdSec', msgid('CrowdSec übernommen'), msgid('CrowdSec übernehmen'), async () => {
        const { applyCrowdsecState } = await import('../crowdsec/mirror');
        const notes = await applyCrowdsecState(wanted, systemActor());
        return { detail: notes.length > 0 ? notes.join(', ') : 'unverändert', changed: notes.length > 0 };
      });
    }
  }

  return {
    ok: results.every(Boolean) && crowdsec !== false,
    dbOk: results.every(Boolean),
    steps,
    changes,
    localFingerprint: await localDataFingerprint().catch(() => null),
    crowdsec,
  };
}
