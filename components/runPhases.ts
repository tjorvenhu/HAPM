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
 * Der Reverse-Proxy-Vorgang (lib/haproxy/provision.ts). Dieselben Phasen für
 * Anlegen, Ändern und Löschen, obwohl nicht jede Art jede durchläuft: ein
 * Löschvorgang beantragt kein Zertifikat, ein Ändern ohne Domainwechsel auch
 * nicht. Eine eigene Liste je Art hieße drei Listen für einen Ablauf, der sich
 * nur in einem übersprungenen Schritt unterscheidet.
 */
export const HAPROXY_PHASES: string[] = [
  'dns',
  'preflight',
  'certificate',
  'checking',
  'installing',
  'cleanup',
];

export const HAPROXY_PHASE_LABELS: Record<string, string> = {
  // Der DNS-Eintrag steht vorn, weil er vor dem Zertifikat gesetzt sein muss.
  // Beim Entfernen läuft er unter „Aufräumen" — dorthin gehört er, und die
  // Liste bliebe sonst nicht monoton.
  dns: msgid('DNS-Eintrag'),
  preflight: msgid('Konfiguration lesen'),
  certificate: msgid('Zertifikat'),
  checking: msgid('Prüfung'),
  installing: msgid('Einsetzen und neu laden'),
  cleanup: msgid('Aufräumen'),
  done: msgid('Fertig'),
};
