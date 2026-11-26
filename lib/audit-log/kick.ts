/**
 * Der Anstoß von `logAudit` an die Weiterleitung, ohne dass `lib/audit.ts` sie
 * kennt.
 *
 * `lib/audit.ts` wird von fast jeder Datei geladen. Hinge die Weiterleitung
 * (Netz, Verschlüsselung, eigene Abfragen) direkt daran, lüde sie jeder Test
 * und jedes Skript mit. So steht hier nur ein Platz für eine Funktion: der
 * Scheduler trägt sie beim Start ein (`startAuditForwarding`), und ohne ihn
 * (Tests, `hapm-admin`) stößt ein neuer Eintrag nichts an.
 */

const globalKick = globalThis as unknown as { __hapmAuditKick?: () => void };

export function setAuditKick(kick: (() => void) | null): void {
  globalKick.__hapmAuditKick = kick ?? undefined;
}

/** Nach einem neuen Eintrag. Wirft nie und wartet auf nichts. */
export function auditWritten(): void {
  try {
    globalKick.__hapmAuditKick?.();
  } catch {
    // Die Weiterleitung darf das Schreiben des Protokolls nicht stören.
  }
}
