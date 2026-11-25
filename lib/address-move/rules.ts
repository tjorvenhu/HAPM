/**
 * Die Regeln des Umzugs auf eine neue Adresse, ohne Datenbank und ohne
 * HAProxy: welche Schritte es gibt, wann die Prüfung den Weg freigibt, wann
 * der Assistent anbietet, den DNS-Eintrag selbst zu setzen. Rein, weil Seite
 * und Route dieselbe Antwort geben müssen und der Test sie nachrechnet.
 *
 * Der Ablauf steht in `./index.ts`, warum er so ist, in `docs/betrieb.md`,
 * „Die Adresse ändern".
 */

import { msgid } from '../i18n/translate';
import type { AddressMoveStage, AddressMoveStageKey, Exposure } from '../types';
import type { AddressVerdict } from '../setup/rules';

export const MOVE_STAGE_LABELS: Record<AddressMoveStageKey, string> = {
  certificate: msgid('Zertifikat für die neue Adresse'),
  service: msgid('Ziel für die neue Adresse anlegen'),
  publicUrl: msgid('Adresse von HAPM umstellen'),
  cleanup: msgid('Ziel der alten Adresse entfernen'),
};

/**
 * Die Schritte in ihrer Reihenfolge. Das alte Ziel geht zuletzt: bis dahin ist
 * die Oberfläche unter beiden Adressen erreichbar, und wer den Assistenten
 * unter der alten offen hat, sieht alles bis auf den letzten Schritt.
 */
export function movePlan(hasPrevious: boolean): AddressMoveStageKey[] {
  return hasPrevious ? ['certificate', 'service', 'publicUrl', 'cleanup'] : ['certificate', 'service', 'publicUrl'];
}

export function newMoveStages(keys: AddressMoveStageKey[]): AddressMoveStage[] {
  return keys.map((key) => ({ key, status: 'pending', detail: null, runId: null }));
}

export type MoveOutcome = 'idle' | 'running' | 'succeeded' | 'failed';

export function moveOutcome(move: { running: boolean; stages: AddressMoveStage[] } | null): MoveOutcome {
  if (!move) return 'idle';
  if (move.running) return 'running';
  if (move.stages.some((stage) => stage.status === 'error')) return 'failed';
  if (move.stages.every((stage) => stage.status === 'ok')) return 'succeeded';
  // Nicht mehr am Laufen, aber nicht fertig: ein Neustart dazwischen.
  return 'failed';
}

/** Wie das Zertifikat entsteht. Dieselbe Unterscheidung wie im Einrichtungsassistenten. */
export type Issuance = 'dns' | 'http' | 'upload';

/**
 * Was die DNS-Prüfung für den nächsten Schritt heißt.
 *
 * - `go`: die Domain zeigt auf diesen Server.
 * - `confirm`: sie zeigt woanders hin (hinter einer Adressumsetzung richtig),
 *   oder die Abfrage ging nicht. Weiter nur mit ausdrücklicher Bestätigung.
 * - `blocked`: es gibt keinen Eintrag. Am Ende des Umzugs ist das alte Ziel
 *   weg, und ohne Eintrag erreichte niemand mehr die Oberfläche. Das gilt
 *   auch, wenn das Zertifikat über DNS-01 entstünde.
 */
export type CheckGate = 'go' | 'confirm' | 'blocked';

export function checkGate(verdict: AddressVerdict): CheckGate {
  if (verdict === 'matches') return 'go';
  if (verdict === 'unresolved') return 'blocked';
  return 'confirm';
}

/**
 * Ob der Assistent anbietet, den Eintrag selbst zu setzen: nur bei einer
 * Installation aus dem Internet, nur ohne Eintrag und nur, wenn die Zone unter
 * „DNS" eingerichtet ist. Intern gehört der Eintrag meist in den DNS-Server
 * des eigenen Netzes, und ein öffentlicher Eintrag auf eine interne Adresse
 * verwerfen manche Router.
 */
export function offerRecord(exposure: Exposure, verdict: AddressVerdict, zoneKnown: boolean): boolean {
  return exposure === 'public' && verdict === 'unresolved' && zoneKnown;
}
