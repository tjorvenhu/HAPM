/**
 * Der Anstoß für den Abgleich nach einer Änderung an den Daten: ein Konto, eine
 * Einstellung, eine DNS-Zone, ein API-Key, eine Sperre in CrowdSec.
 *
 * ── Warum er am Protokoll hängt ──
 *
 * Für die Dateien stößt `withProxyLock` an: jeder Schreibweg nimmt es. Für die
 * Daten gibt es keine solche Sperre, aber eine andere Stelle, an der jeder Weg
 * vorbeikommt: jede Handlung schreibt eine Zeile ins Protokoll (`logAudit`).
 * Ein Anstoß in den Routen wäre der, der bei der nächsten neuen Route fehlt.
 *
 * Ob sich wirklich etwas geändert hat, entscheidet nicht diese Datei, sondern
 * der Fingerabdruck beim Senden. Ein Anstoß zu viel kostet eine Auskunft je
 * Folgeknoten, einer zu wenig fünf Minuten bis zur regelmäßigen Prüfung.
 *
 * Ohne Importe außer den Tabellen des Protokolls: `lib/audit.ts` lädt diese
 * Datei, und das lädt fast alles.
 */

import { areaOf, type AuditArea } from '../audit-log/labels';

/** Die Bereiche des Protokolls, deren Handlungen abgeglichene Daten ändern. */
const SYNCED_AREAS: Record<AuditArea, boolean> = {
  auth: false,
  accounts: true,
  proxy: false,
  certificates: false,
  dns: true,
  crowdsec: true,
  backup: false,
  updates: false,
  sync: false,
  settings: true,
  tokens: true,
  audit: false,
};

/** Aus dem Bereich „Anmeldung“ ändern nur diese etwas, das abgeglichen wird. */
const SYNCED_ACTIONS: ReadonlySet<string> = new Set(['password_reset_completed', '2fa_recovery_code_used']);

export function changesSyncedData(action: string): boolean {
  if (SYNCED_ACTIONS.has(action)) return true;
  const area = areaOf(action);
  return area !== null && SYNCED_AREAS[area];
}

const hook = globalThis as typeof globalThis & { __hapm_data_change?: (() => void) | null };

/**
 * Wer nach einer Änderung an den Daten Bescheid bekommen will (der Abgleich,
 * über den Scheduler). Am globalen Objekt und nicht im Modul: Routen und
 * Scheduler laufen in Next in getrennten Modulgraphen.
 */
export function onDataChange(listener: (() => void) | null): void {
  hook.__hapm_data_change = listener;
}

/** Von `logAudit` nach jeder Zeile gerufen. Wirft nie. */
export function auditedChange(action: string): void {
  try {
    if (changesSyncedData(action)) hook.__hapm_data_change?.();
  } catch {
    // Der Anstoß darf die Handlung nicht scheitern lassen.
  }
}
