import type { RunStatus, UpdateComponent, UpdateState } from '@/lib/types';
import {
  formatDate as formatDateIn,
  formatDateTime as formatDateTimeIn,
  formatDuration,
  formatRelative,
  msgid,
  type Locale,
} from '@/lib/i18n';

/**
 * Zeit- und Zustandsangaben, wie Übersicht und Updates sie beide schreiben.
 *
 * Die Formate liegen in `lib/i18n/format.ts`, hier stehen sie mit Deutsch als
 * Vorgabe, damit die Seiten bis zur Umstellung unverändert bleiben. Eine
 * umgestellte Seite gibt `locale` aus `useT()` mit. Die Beschriftungen sind
 * Schlüssel (`msgid`): die Seite zeigt sie mit `t(...)`.
 */

export const COMPONENT_LABELS: Record<UpdateComponent, string> = {
  haproxy: 'HAProxy',
  hapm: 'HAPM',
  acme: 'acme.sh',
  crowdsec: 'CrowdSec',
  'crowdsec-bouncer': 'CrowdSec-Bouncer',
};

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  running: msgid('Läuft'),
  success: msgid('Erfolgreich'),
  warning: msgid('Mit Hinweisen'),
  error: msgid('Fehlgeschlagen'),
  cancelled: msgid('Abgebrochen'),
};

export const RUN_STATUS_CLASS: Record<RunStatus, string> = {
  running: 'badge-neutral',
  success: 'badge-success',
  warning: 'badge-warning',
  error: 'badge-danger',
  cancelled: 'badge-neutral',
};

export function formatDateTime(iso: string | null, locale: Locale = 'de'): string {
  return formatDateTimeIn(locale, iso);
}

export function formatDate(iso: string | null, locale: Locale = 'de'): string {
  return formatDateIn(locale, iso);
}

/** „vor 3 Minuten". Unter einer Minute steht kein Sekundenzähler, der bei jedem Laden springt. */
export function formatAgo(now: number, iso: string | null, locale: Locale = 'de'): string {
  return formatRelative(locale, now, iso);
}

/** Eine Laufzeit: „3 Tage 4 Std.", „5 Std. 12 Min.", „12 Min.". */
export function formatUptime(now: number, iso: string | null, locale: Locale = 'de'): string {
  return formatDuration(locale, now, iso);
}

/** Die Dauer eines Laufs als `mm:ss`. */
export function formatClock(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * „3.4.8 → 3.4.9", wenn beide Fassungen bekannt und verschieden sind. Ein neues
 * Abbild derselben Fassung (Sicherheitsstand des Grundsystems) hat keine zwei Nummern.
 */
export function versionStep(state: Pick<UpdateState, 'currentVersion' | 'latestVersion'>): string | null {
  if (!state.currentVersion || !state.latestVersion || state.currentVersion === state.latestVersion) return null;
  return `${state.currentVersion} → ${state.latestVersion}`;
}
