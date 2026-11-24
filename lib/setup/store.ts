import { decrypt, encrypt } from '../crypto';
import { getSingleton, updateDocument } from '../db';
import { COLLECTIONS, SETUP_ID, type SetupState } from '../types';
import { EMPTY_SETUP, type SetupChoices } from './rules';

/** Die eine Zeile des Assistenten. Fehlt ein Feld (ältere Zeile), gilt die Vorgabe. */
export async function getSetupState(): Promise<SetupChoices> {
  const row = await getSingleton<SetupState>(COLLECTIONS.SETUP_STATE, SETUP_ID, EMPTY_SETUP);
  return {
    exposure: row.exposure ?? EMPTY_SETUP.exposure,
    dns: row.dns ?? EMPTY_SETUP.dns,
    dnsHook: row.dnsHook ?? null,
    address: row.address ?? EMPTY_SETUP.address,
    domain: row.domain ?? null,
    wildcard: row.wildcard === true,
    wildcardBase: row.wildcardBase ?? null,
    execution: row.execution ?? null,
  };
}

/**
 * Das Token des DNS-Anbieters für die Dauer der Einrichtung, siehe
 * `SetupState.dnsAccess`. Ein Token, das sich nicht mehr entschlüsseln lässt
 * (anderer Schlüssel), gilt als nicht vorhanden.
 */
export async function getDnsAccess(): Promise<{ hook: string; token: string } | null> {
  const row = await getSingleton<SetupState>(COLLECTIONS.SETUP_STATE, SETUP_ID, EMPTY_SETUP);
  if (!row.dnsAccess?.hook || !row.dnsAccess.token) return null;
  try {
    return { hook: row.dnsAccess.hook, token: decrypt(row.dnsAccess.token) };
  } catch {
    return null;
  }
}

export async function setDnsAccess(access: { hook: string; token: string } | null): Promise<void> {
  await getSetupState();
  await updateDocument<SetupState>(COLLECTIONS.SETUP_STATE, SETUP_ID, {
    dnsAccess: access ? { hook: access.hook, token: encrypt(access.token) } : null,
  });
}

export async function updateSetupState(patch: Partial<SetupChoices>): Promise<SetupChoices> {
  await getSetupState();
  await updateDocument<SetupState>(COLLECTIONS.SETUP_STATE, SETUP_ID, patch);
  return getSetupState();
}
