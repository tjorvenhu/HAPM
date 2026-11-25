/**
 * Die eigenen Vorgänge einer Gruppenseite, solange sie laufen.
 *
 * Eine Liste und nicht ein einzelner Lauf: wer drei Ziele kurz nacheinander
 * anlegt, startet drei Läufe, die hintereinander am Lock des Proxys warten
 * (`withProxyLock` in lib/haproxy/provision.ts). Mit einem einzelnen Feld
 * überschrieb jeder Start den vorigen. Oben stand dann eine Platzhalterkarte
 * statt drei, und die verdrängten Läufe bekamen nie ihre Meldung zum Abschluss.
 *
 * Rein und ohne React, damit die Regeln (welcher Lauf welche Karte trägt, wann
 * ein Platzhalter weicht) einen Test haben.
 */

import { HAPROXY_PHASE_LABELS } from '@/components/runPhases';
import type { ProvisionStep } from '@/lib/haproxy/provision';

/**
 * Ein eigener Vorgang. Er trägt mehr als seine ID, weil die Liste ihn zeigt:
 * bei einem neuen Eintrag als Platzhalterkarte, bei einem bestehenden als
 * Karte mit Spinner und der aktuellen Phase. `serviceId` verbindet beides, die
 * Zeile in der Konfiguration heißt so.
 */
export interface PendingRun {
  id: string;
  label: string;
  serviceId: string;
  /** Was auf der Platzhalterkarte oben steht: die Hauptdomain oder der Port. */
  title: string;
  /** Ein Anlegen hat noch keine Karte in der Liste, alles andere schon. */
  isNew: boolean;
  /** Beim Löschen steht die Karte noch da und ist im Begriff zu verschwinden. */
  kind: 'write' | 'delete';
  /** Aus dem Lauf nachgezogen, als deutscher Schlüssel aus
   *  `HAPROXY_PHASE_LABELS`: die Karten übersetzen ihn selbst. */
  phase: string | null;
  /** Die Schritte aus dem Lauf, solange er läuft. Die Platzhalterkarte zeigt sie. */
  steps: ProvisionStep[];
}

/** Was `/api/haproxy/runs/[id]` über einen Lauf sagt, soweit es hier zählt. */
export interface RunSnapshot {
  status: string;
  phase: string | null;
  steps?: unknown;
}

/** Ein neuer Lauf kommt hinten an: die Reihenfolge ist die, in der sie am Lock stehen. */
export function addPendingRun(runs: PendingRun[], run: PendingRun): PendingRun[] {
  return runs.some((entry) => entry.id === run.id) ? runs : [...runs, run];
}

export function removePendingRuns(runs: PendingRun[], ids: ReadonlySet<string>): PendingRun[] {
  return runs.some((entry) => ids.has(entry.id)) ? runs.filter((entry) => !ids.has(entry.id)) : runs;
}

/**
 * Phase und Schritte eines laufenden Laufs übernehmen.
 *
 * Ohne Änderung kommt dieselbe Liste zurück, sonst stieße jeder Poll-Takt
 * einen Render aller Karten an.
 */
export function applyRunSnapshot(
  runs: PendingRun[],
  id: string,
  snapshot: RunSnapshot
): PendingRun[] {
  const phase = snapshot.phase ? (HAPROXY_PHASE_LABELS[snapshot.phase] ?? null) : null;
  const steps: ProvisionStep[] = Array.isArray(snapshot.steps) ? (snapshot.steps as ProvisionStep[]) : [];
  let changed = false;
  const next = runs.map((run) => {
    if (run.id !== id) return run;
    if (run.phase === phase && JSON.stringify(run.steps) === JSON.stringify(steps)) return run;
    changed = true;
    return { ...run, phase, steps };
  });
  return changed ? next : runs;
}

/**
 * Die Platzhalterkarten: je laufendem Anlegen eine, in der Reihenfolge des Starts.
 *
 * Steht die ID schon in der gelesenen Konfiguration, trägt die echte Karte den
 * Lauf (`runForEntry`) und der Platzhalter fällt weg. Das passiert, wenn der
 * 20-Sekunden-Takt die Datei liest, nachdem der Lauf sie geschrieben hat, aber
 * bevor er fertig ist: sonst stünde derselbe Eintrag zweimal da.
 */
export function placeholderRuns(runs: PendingRun[], knownIds: ReadonlySet<string>): PendingRun[] {
  return runs.filter((run) => run.isNew && !knownIds.has(run.serviceId));
}

/**
 * Der Lauf, den die Karte eines bestehenden Eintrags zeigt.
 *
 * Bei mehreren für denselben Eintrag (erst ändern, dann löschen) der zuerst
 * gestartete: er steht am Lock vorn, also ist es der, der gerade etwas tut.
 */
export function runForEntry(runs: PendingRun[], serviceId: string): PendingRun | null {
  return runs.find((run) => run.serviceId === serviceId) ?? null;
}

/** Der Lauf wartet am Lock hinter einem anderen (Phase `queued`). */
export function isQueued(run: PendingRun): boolean {
  return run.phase === HAPROXY_PHASE_LABELS.queued;
}
