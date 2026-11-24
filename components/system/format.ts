import type { RunStatus, UpdateComponent, UpdateState } from '@/lib/types';

/** Zeit- und Zustandsangaben, wie Übersicht und Updates sie beide schreiben. */

export const COMPONENT_LABELS: Record<UpdateComponent, string> = {
  haproxy: 'HAProxy',
  hapm: 'HAPM',
  acme: 'acme.sh',
};

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  running: 'Läuft',
  success: 'Erfolgreich',
  warning: 'Mit Hinweisen',
  error: 'Fehlgeschlagen',
  cancelled: 'Abgebrochen',
};

export const RUN_STATUS_CLASS: Record<RunStatus, string> = {
  running: 'badge-neutral',
  success: 'badge-success',
  warning: 'badge-warning',
  error: 'badge-danger',
  cancelled: 'badge-neutral',
};

export function formatDateTime(iso: string | null): string {
  if (!iso) return 'Unbekannt';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDate(iso: string | null): string {
  if (!iso) return 'Unbekannt';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** „vor 3 Minuten". Unter einer Minute steht kein Sekundenzähler, der bei jedem Laden springt. */
export function formatAgo(now: number, iso: string | null): string {
  if (!iso) return 'Unbekannt';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return 'vor weniger als einer Minute';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `vor ${plural(minutes, 'Minute', 'Minuten')}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `vor ${plural(hours, 'Stunde', 'Stunden')}`;
  return `vor ${plural(Math.floor(hours / 24), 'Tag', 'Tagen')}`;
}

/** Eine Laufzeit: „3 Tage 4 Std.", „5 Std. 12 Min.", „12 Min.". */
export function formatUptime(now: number, iso: string | null): string {
  if (!iso) return 'Unbekannt';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'Unbekannt';
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  if (minutes < 1) return 'unter 1 Min.';
  if (minutes < 60) return `${minutes} Min.`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} Std. ${minutes % 60} Min.`;
  const days = Math.floor(hours / 24);
  return `${plural(days, 'Tag', 'Tage')} ${hours % 24} Std.`;
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
