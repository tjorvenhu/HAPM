/**
 * Die Phasen des abgekoppelt laufenden Vorgangs, an einer Stelle.
 *
 * Die Pille unten rechts zeigt dieselben Wörter wie das Overlay, das sie öffnet,
 * und die Logs-Seite dieselben wie beide: driften dürfen sie also nicht.
 *
 * Nur mit `lib/i18n/translate` als Import, damit Server- und Client-Komponenten
 * dieselbe Datei nehmen können. Die Beschriftungen sind deutsche Schlüssel
 * (`msgid`), wer sie zeigt, übersetzt sie mit `t()`.
 */

import { msgid } from '@/lib/i18n/translate';

/**
 * Der Reverse-Proxy-Vorgang (lib/haproxy/provision.ts) für ein Ziel: Anlegen,
 * Ändern, ein Zertifikat. Nicht jeder Lauf durchläuft jede Phase (ein Ändern
 * ohne neue Domain beantragt kein Zertifikat), die Reihe zeigt trotzdem alle:
 * es ist derselbe Ablauf mit einem übersprungenen Schritt.
 */
export const HAPROXY_PHASES: string[] = [
  'dns',
  'preflight',
  'certificate',
  'checking',
  'installing',
  'cleanup',
];

/** Was nur die Konfiguration ändert: Einstellungen, Gruppen, Weiterleitungen, Import. Kein DNS, kein Zertifikat. */
const CONFIG_PHASES: string[] = ['preflight', 'checking', 'installing'];

/**
 * Die Phasen, die ein Lauf dieser Art durchläuft. Ohne Art (ältere Zeile) die
 * volle Reihe. Die Liste je Art folgt den `steps.phase(…)` in `provision.ts`.
 */
export function haproxyPhases(action: string | null | undefined): string[] {
  switch (action) {
    case 'delete':
      return ['preflight', 'checking', 'installing', 'cleanup'];
    case 'settings':
    case 'scope-add':
    case 'scope-remove':
    case 'stream-create':
    case 'stream-update':
    case 'stream-delete':
    case 'import':
      return CONFIG_PHASES;
    default:
      return HAPROXY_PHASES;
  }
}

export const HAPROXY_PHASE_LABELS: Record<string, string> = {
  // Der DNS-Eintrag steht vorn, weil er vor dem Zertifikat gesetzt sein muss.
  // Beim Entfernen läuft er unter „Aufräumen" — dorthin gehört er, und die
  // Liste bliebe sonst nicht monoton.
  // Nicht in `HAPROXY_PHASES`: Warten ist kein Schritt des Ablaufs, sondern
  // die Zeit davor. Im Overlay steht es nur als Zeile unter dem Stepper.
  queued: msgid('Wartet'),
  dns: msgid('DNS-Eintrag'),
  preflight: msgid('Konfiguration lesen'),
  certificate: msgid('Zertifikat'),
  checking: msgid('Prüfung'),
  installing: msgid('Einsetzen und neu laden'),
  cleanup: msgid('Aufräumen'),
  done: msgid('Fertig'),
};
