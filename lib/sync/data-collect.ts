/**
 * Den Datenteil eines Pakets aus der Datenbank und aus CrowdSec lesen
 * (`data.ts` sagt, was dazugehört). Auf dem Hauptknoten zum Packen, auf dem
 * Folgeknoten, um zu sehen, ob seine Daten noch so liegen wie übernommen.
 */

import { listAll } from '../db';
import { readAccountRows } from '../db/account-rows';
import { decrypt } from '../crypto';
import { getSettings } from '../settings';
import { crowdsecInstalled } from '../crowdsec/paths';
import { COLLECTIONS, type DnsZone, type ServiceToken, type TwoFactorConfig } from '../types';
import {
  SYNCED_SETTINGS,
  dataFingerprint,
  type SyncCrowdsec,
  type SyncData,
  type SyncSettingsData,
  type SyncedSettingKey,
} from './data';

/** Der Klartext, oder `null`, wenn sich der Wert mit dem Schlüssel dieses Knotens nicht lesen lässt. */
function open(stored: string | null | undefined): string | null {
  if (!stored) return null;
  try {
    return decrypt(stored);
  } catch {
    return null;
  }
}

/** Alles aus der Datenbank. CrowdSec liest `collectCrowdsec`. */
export async function collectDbData(): Promise<Omit<SyncData, 'crowdsec'>> {
  const [rows, twoFactor, settings, zones, tokens] = await Promise.all([
    readAccountRows(),
    listAll<TwoFactorConfig>(COLLECTIONS.TWO_FACTOR),
    getSettings(),
    listAll<DnsZone>(COLLECTIONS.DNS_ZONES),
    listAll<ServiceToken>(COLLECTIONS.SERVICE_TOKENS),
  ]);
  const known = new Set(rows.users.map((user) => user.id));

  const synced = Object.fromEntries(SYNCED_SETTINGS.map((key) => [key, settings[key]])) as Pick<
    typeof settings,
    SyncedSettingKey
  >;
  const settingsData: SyncSettingsData = { ...synced, smtpPass: open(settings.smtpPass) };

  return {
    accounts: {
      ...rows,
      twoFactor: twoFactor
        // Eine Zeile ohne Konto ist ein Rest und kein zweiter Faktor.
        .filter((row) => known.has(row.userId))
        .map((row) => ({
          userId: row.userId,
          secret: open(row.secret),
          enabled: row.enabled === true,
          recoveryCodes: Array.isArray(row.recoveryCodes) ? row.recoveryCodes : [],
          recoveryCodesCreatedAt: row.recoveryCodesCreatedAt ?? null,
        })),
    },
    settings: settingsData,
    dnsZones: zones.map((zone) => ({
      id: zone.$id,
      provider: zone.provider ?? null,
      name: zone.name,
      zoneId: zone.zoneId,
      access: open(zone.apiToken),
    })),
    serviceTokens: tokens.map((token) => ({
      id: token.$id,
      name: token.name,
      tokenHash: token.tokenHash,
      prefix: token.prefix,
      description: token.description ?? null,
      createdBy: token.createdBy ?? null,
      revokedAt: token.revokedAt ?? null,
      scopes: token.scopes ?? null,
      areas: token.areas ?? null,
      allowedIps: token.allowedIps ?? null,
    })),
  };
}

const lastCrowdsec = globalThis as unknown as { __hapmSyncCrowdsec?: SyncCrowdsec };

/**
 * CrowdSec, wie dieser Knoten es weitergibt. `null`: es gibt hier keines, oder
 * es antwortet gerade nicht und hat seit dem Start von HAPM noch nie
 * geantwortet. Dann fehlt der Teil im Paket, und der Folgeknoten behält, was er
 * hat.
 *
 * Antwortet es nur gerade nicht (nach jeder Änderung an den Regeln startet es
 * neu), gilt der zuletzt gelesene Stand: sonst gälte jede solche Pause als
 * Änderung, und danach noch einmal.
 */
export async function collectCrowdsec(): Promise<SyncCrowdsec | null> {
  if (!crowdsecInstalled()) return null;
  try {
    const { readCrowdsecState } = await import('../crowdsec/mirror');
    const state = await readCrowdsecState();
    lastCrowdsec.__hapmSyncCrowdsec = state;
    return state;
  } catch {
    return lastCrowdsec.__hapmSyncCrowdsec ?? null;
  }
}

export async function collectData(): Promise<SyncData> {
  const [db, crowdsec] = await Promise.all([collectDbData(), collectCrowdsec()]);
  return { ...db, crowdsec };
}

/** Der Fingerabdruck der Daten dieses Knotens, ohne CrowdSec. */
export async function localDataFingerprint(): Promise<string> {
  return dataFingerprint(await collectDbData());
}
