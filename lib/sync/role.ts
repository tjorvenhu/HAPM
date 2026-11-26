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
