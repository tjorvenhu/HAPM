/**
 * Die Schritte eines Updates in der Reihenfolge, in der `apply.ts` sie schreibt.
 *
 * Ein Lauf meldet einen Schritt erst, wenn er fertig ist. Mit dieser Liste kann
 * die Oberfläche zeigen, welcher gerade läuft und was noch kommt. Rein und ohne
 * Importe, damit auch eine Client-Seite sie benutzen darf.
 * `tests/updates/plan.test.ts` hält fest, dass die Namen zu `apply.ts` passen.
 */

import type { UpdateComponent } from '../types';

/** Nach diesem Schritt ersetzt ein Helfer den Container von HAPM, und die Oberfläche ist kurz weg. */
export const HANDOVER_STEP = 'Übergabe';

export const UPDATE_PLAN: Record<UpdateComponent, readonly string[]> = {
  haproxy: ['Abbild holen', 'Konfiguration mit der neuen Fassung prüfen', 'Container ersetzen', 'Altes Abbild entfernen'],
  hapm: ['Abbild holen', HANDOVER_STEP, 'Neuer Container'],
  acme: ['acme.sh aktualisieren'],
};

/**
 * Was nach den gemeldeten Schritten noch aussteht. Der erste Eintrag läuft gerade.
 * Ein gescheiterter Schritt beendet den Lauf, danach steht nichts mehr aus.
 */
export function remainingSteps(component: UpdateComponent, done: { label: string; ok: boolean }[]): string[] {
  if (done.some((step) => !step.ok)) return [];
  const plan = UPDATE_PLAN[component];
  const last = done.reduce((index, step) => Math.max(index, plan.indexOf(step.label)), -1);
  return plan.slice(last + 1);
}
