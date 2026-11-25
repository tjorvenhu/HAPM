/**
 * Was ein Sicherungslauf der Reihe nach tut. `run.ts` meldet einen Schritt
 * erst, wenn er fertig ist: an der Zahl der gemeldeten zeigt sich, welcher
 * gerade läuft. Rein (nur `lib/i18n`), damit die Oberfläche sie benutzen darf.
 */

import { msgid } from '../i18n';

export const BACKUP_PLAN: readonly string[] = [
  msgid('Datenbank herausschreiben'),
  msgid('Schlüssel dazulegen'),
  msgid('Archiv schreiben'),
  msgid('Alte Sicherungen aufräumen'),
];

/** Was nach den gemeldeten Schritten noch aussteht. Der erste Eintrag läuft gerade. */
export function remainingBackupSteps(running: boolean, done: { ok: boolean }[]): string[] {
  if (!running || done.some((step) => !step.ok)) return [];
  return BACKUP_PLAN.slice(done.length);
}
