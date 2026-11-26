/**
 * Die Rolle dieses Knotens, und die eine Regel, die an ihr hängt: ein
 * Folgeknoten ändert nichts an dem, was der Abgleich überschreibt.
 *
 * ── Wo gesperrt wird ──
 *
 * An zwei Stellen, die jeder Weg nimmt: `startHaproxyRun` (bevor ein Lauf
 * entsteht, als Auskunft an Formular, API und MCP) und `withProxyLock` (unter
 * der Sperre, für alles, was ohne Lauf schreibt, und noch einmal für die Läufe:
 * zwischen Anfrage und Lauf kann die Rolle gewechselt haben). Eine Sperre in
 * den Routen wäre die, die bei der nächsten neuen Route fehlt.
 *
 * Was ein Folgeknoten weiter selbst tut, nimmt `withProxyLockLocal` und steht
 * dort mit Grund.
 *
 * Klein gehalten: `lib/haproxy/provision.ts` importiert diese Datei, und sie
 * erreicht deshalb nichts außer der Datenbank.
 */

import { ApiError } from '../api';
import { msg } from '../i18n/translate';
import { getSyncSettings } from './store';
import type { SyncRole } from './types';

const warned = globalThis as unknown as { __hapmSyncRoleWarned?: boolean };

/**
 * Die Rolle. Lässt sie sich nicht lesen, gilt „einzeln": ohne Datenbank
 * entsteht ohnehin kein Lauf, und ein Knoten, der seine Rolle nicht kennt, soll
 * deshalb nicht jede Änderung ablehnen.
 */
export async function getSyncRole(): Promise<SyncRole> {
  try {
    return (await getSyncSettings()).role;
  } catch (err) {
    if (!warned.__hapmSyncRoleWarned) {
      warned.__hapmSyncRoleWarned = true;
      console.error('[abgleich] Die Rolle dieses Knotens ließ sich nicht lesen, es gilt „einzeln":', err instanceof Error ? err.message : err);
    }
    return 'single';
  }
}

export async function isReplica(): Promise<boolean> {
  return (await getSyncRole()) === 'replica';
}

export function replicaRefusal(): ApiError {
  return new ApiError(
    msg(
      'Dieser Knoten ist ein Folgeknoten. Ziele, Zertifikate, Fehlerseiten und Einstellungen des Proxys kommen vom Hauptknoten und werden dort geändert.'
    ),
    409
  );
}

/** Wirft auf einem Folgeknoten. Für alles, was der Abgleich überschreibt. */
export async function assertProxyWritable(): Promise<void> {
  if (await isReplica()) throw replicaRefusal();
}

/**
 * Was der Abgleich außer den Dateien überträgt (`data.ts`). Auch das ändert
 * ein Folgeknoten nicht: der nächste Abgleich nähme es zurück, und bis dahin
 * gälte auf zwei Knoten Verschiedenes.
 */
export type SyncedData = 'accounts' | 'settings' | 'dns' | 'tokens' | 'crowdsec';

export function replicaDataRefusal(what: SyncedData): ApiError {
  switch (what) {
    case 'accounts':
      return new ApiError(
        msg('Dieser Knoten ist ein Folgeknoten. Konten, Passwörter, Passkeys und zweite Faktoren kommen vom Hauptknoten und werden dort geändert.'),
        409
      );
    case 'settings':
      return new ApiError(msg('Dieser Knoten ist ein Folgeknoten. Diese Einstellungen kommen vom Hauptknoten und werden dort geändert.'), 409);
    case 'dns':
      return new ApiError(msg('Dieser Knoten ist ein Folgeknoten. DNS-Zonen kommen vom Hauptknoten und werden dort geändert.'), 409);
    case 'tokens':
      return new ApiError(msg('Dieser Knoten ist ein Folgeknoten. API-Keys kommen vom Hauptknoten und werden dort geändert.'), 409);
    case 'crowdsec':
      return new ApiError(
        msg('Dieser Knoten ist ein Folgeknoten. Sperren von Hand und Regeln von CrowdSec kommen vom Hauptknoten und werden dort geändert.'),
        409
      );
  }
}

/**
 * Wirft auf einem Folgeknoten. Gerufen in den Funktionen unter `lib/`, die
 * Oberfläche, API und MCP gemeinsam nehmen, nicht in den Routen.
 */
export async function assertDataWritable(what: SyncedData): Promise<void> {
  if (await isReplica()) throw replicaDataRefusal(what);
}
