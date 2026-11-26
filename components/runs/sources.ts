/**
 * Woher das Fenster der Läufe einen Lauf liest und wie es ihn nennt, je Art.
 *
 * Jede Art hat ihren eigenen Endpunkt und ihre eigene Form. Hier wird daraus
 * eine `RunView`, damit `RunOverlay`, die Pille und die Meldung am Ende nur
 * eine Form kennen. Rein bis auf `fetch` über das übergebene `apiFetch`.
 */

import { COMPONENT_LABELS } from '@/components/system/format';
import { remainingSteps, HANDOVER_STEP } from '@/lib/updates/plan';
import { remainingBackupSteps } from '@/lib/backup/plan';
import { RESTORE_PLAN, RESTORE_STEP_LABELS } from '@/lib/backup/restore-script';
import type { Translator } from '@/lib/i18n';
import type { HaproxyStep, RunStatus, UpdateComponent } from '@/lib/types';
import type { RunKind, RunRef } from './runs';

export interface RunView {
  kind: RunKind;
  status: RunStatus;
  startedAt: string;
  completedAt: string | null;
  /** Ein deutscher Schlüssel oder ein schon übersetzter Text, gezeigt mit `t()`. */
  error: string | null;
  /** Was fertig ist, in der Reihenfolge des Laufs. */
  steps: HaproxyStep[];
  /** Was noch kommt, der erste Eintrag läuft gerade. Nur solange der Lauf läuft. */
  pending: string[];
  /** Nur Reverse-Proxy: Phase für die Reihe aus Kreisen und das Protokoll als Text. */
  phase: string | null;
  output: string | null;
  /** Wofür der Lauf ist: Dienst, Bestandteil, Ordner, Archiv. */
  subject: string | null;
  /** Nur Reverse-Proxy: die Art (`settings`, `create`, …), sie bestimmt die Phasen. */
  action: string | null;
  component: UpdateComponent | null;
  toVersion: string | null;
  fromVersion: string | null;
  fileName: string | null;
}

type ApiFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type LoadResult =
  | { state: 'ok'; view: RunView }
  /** Den Lauf gibt es nicht (mehr). */
  | { state: 'missing' }
  /** HAPM hat nicht oder nicht mit JSON geantwortet: beim Tausch und beim Zurückspielen zu erwarten. */
  | { state: 'offline' }
  /** HAPM antwortet, aber ohne Sitzung: nach dem Zurückspielen sind alle Sitzungen weg. */
  | { state: 'signed-out' };

const ENDPOINTS: Record<RunKind, string> = {
  haproxy: '/api/haproxy/runs',
  update: '/api/updates/runs',
  backup: '/api/backup/runs',
  restore: '/api/backup/restore/runs',
  crowdsec: '/api/crowdsec/rules/runs',
};

interface RawRun {
  status: RunStatus;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  steps?: HaproxyStep[];
  phase?: string | null;
  output?: string;
  serverName?: string;
  action?: string;
  component?: UpdateComponent;
  fromVersion?: string | null;
  toVersion?: string | null;
  hostPath?: string;
  fileName?: string | null;
  /** Nur Regeln von CrowdSec: was noch wartet, vom Server schon übersetzt. */
  pending?: string[];
}

function toView(kind: RunKind, raw: RawRun): RunView {
  const steps = raw.steps ?? [];
  const running = raw.status === 'running';
  let pending: string[] = [];
  let subject: string | null = null;
  if (kind === 'haproxy') {
    // Die Einstellungen tragen einen festen Namen (`globale-einstellungen`), der niemandem etwas sagt.
    subject = raw.action === 'settings' ? null : (raw.serverName ?? null);
  } else if (kind === 'update' && raw.component) {
    subject = COMPONENT_LABELS[raw.component];
    if (running) pending = remainingSteps(raw.component, steps);
  } else if (kind === 'backup') {
    subject = raw.hostPath ?? null;
    pending = remainingBackupSteps(running, steps);
  } else if (kind === 'restore') {
    subject = raw.fileName ?? null;
    if (running && !steps.some((step) => !step.ok)) {
      pending = RESTORE_PLAN.slice(steps.length).map((step) => RESTORE_STEP_LABELS[step]);
    }
  } else if (kind === 'crowdsec') {
    // Die Schlange wächst, während der Lauf arbeitet: es gibt keinen festen Plan.
    if (running) pending = raw.pending ?? [];
  }
  return {
    kind,
    status: raw.status,
    startedAt: raw.startedAt,
    completedAt: raw.completedAt,
    error: raw.error,
    steps,
    pending,
    phase: kind === 'haproxy' ? (raw.phase ?? null) : null,
    output: kind === 'haproxy' ? (raw.output ?? '') : null,
    subject,
    action: kind === 'haproxy' ? (raw.action ?? null) : null,
    component: raw.component ?? null,
    fromVersion: raw.fromVersion ?? null,
    toVersion: raw.toVersion ?? null,
    fileName: raw.fileName ?? null,
  };
}

export async function loadRun(apiFetch: ApiFetch, ref: RunRef): Promise<LoadResult> {
  let res: Response;
  let body: { success?: boolean; data?: RawRun } | null;
  try {
    res = await apiFetch(`${ENDPOINTS[ref.kind]}/${encodeURIComponent(ref.id)}`, { cache: 'no-store' });
    body = await res.json();
  } catch {
    return { state: 'offline' };
  }
  if (res.status === 401) return { state: 'signed-out' };
  if (res.status === 404) return { state: 'missing' };
  if (!body?.success || !body.data) return { state: 'offline' };
  return { state: 'ok', view: toView(ref.kind, body.data) };
}

/** Ob die Oberfläche bei diesem Lauf kurz weg ist und danach ein anderer Prozess antwortet. */
export function replacesHapm(kind: RunKind, component: UpdateComponent | null | undefined): boolean {
  return kind === 'restore' || (kind === 'update' && component === 'hapm');
}

/** Ob ein Update von HAPM bis zur Übergabe gekommen ist: dann läuft danach ein neues Abbild. */
export function handedOver(view: RunView): boolean {
  return view.steps.some((step) => step.label === HANDOVER_STEP);
}

export function firstFailedStep(view: RunView): HaproxyStep | null {
  return view.steps.find((step) => !step.ok) ?? null;
}

/** Die Überschrift des Fensters. */
export function runTitle(view: RunView | null, ref: RunRef, t: Translator['t']): string {
  const running = !view || view.status === 'running';
  const failed = view?.status === 'error';
  const subject = view?.subject ?? '';
  switch (ref.kind) {
    case 'update':
      return running
        ? t('{component} wird aktualisiert', { component: subject })
        : failed
          ? t('{component}: Update fehlgeschlagen', { component: subject })
          : t('{component} aktualisiert', { component: subject });
    case 'backup':
      return running ? t('Sicherung läuft') : failed ? t('Sicherung fehlgeschlagen') : t('Sicherung geschrieben');
    case 'restore':
      return running
        ? t('Wird zurückgespielt: {name}', { name: subject })
        : failed
          ? t('Zurückspielen fehlgeschlagen: {name}', { name: subject })
          : t('Zurückgespielt: {name}', { name: subject });
    case 'crowdsec':
      return running
        ? t('CrowdSec-Regeln werden geändert')
        : failed
          ? t('CrowdSec-Regeln: Änderung fehlgeschlagen')
          : t('CrowdSec-Regeln geändert');
    default: {
      const noun = ref.label ?? (view?.action === 'settings' ? t('Globale Einstellungen') : t('Reverse-Proxy'));
      const head = running
        ? t('{noun} läuft', { noun })
        : failed
          ? t('{noun} fehlgeschlagen', { noun })
          : t('{noun} abgeschlossen', { noun });
      return subject ? `${head}: ${subject}` : head;
    }
  }
}

/** Eine Zeile unter der Überschrift: wohin, von welcher Fassung auf welche. */
export function runContext(view: RunView | null): string | null {
  if (!view) return null;
  if (view.kind === 'backup') return view.subject;
  if (view.kind === 'update' && view.fromVersion && view.toVersion && view.fromVersion !== view.toVersion) {
    return `${view.fromVersion} → ${view.toVersion}`;
  }
  return null;
}

export interface FinishedToast {
  variant: 'success' | 'error' | 'warning' | 'info';
  title: string;
  message: string;
}

/** Die Meldung am Ende eines Laufs. */
export function finishedToast(view: RunView, ref: RunRef, t: Translator['t']): FinishedToast {
  const failed = view.status === 'error';
  const failedStep = firstFailedStep(view);
  const failure = view.error
    ? t(view.error)
    : failedStep
      ? t('Fehlgeschlagen bei: {step}', { step: t(failedStep.label) })
      : t('Die Schritte stehen im Fenster des Laufs.');

  switch (ref.kind) {
    case 'update': {
      const label = view.subject ?? '';
      if (failed) return { variant: 'error', title: t('{component}: Update fehlgeschlagen', { component: label }), message: failure };
      if (view.component !== 'acme' && view.steps.length <= 1) {
        return {
          variant: 'info',
          title: label,
          message: t('Das laufende Abbild ist schon das neueste. Es wurde nichts getauscht.'),
        };
      }
      return {
        variant: view.status === 'warning' ? 'warning' : 'success',
        title: t('{component} aktualisiert', { component: label }),
        message: view.toVersion ? t('Es läuft jetzt {version}.', { version: view.toVersion }) : t('Das neue Abbild läuft.'),
      };
    }
    case 'backup':
      return failed
        ? { variant: 'error', title: t('Sicherung fehlgeschlagen'), message: failure }
        : {
            variant: view.status === 'warning' ? 'warning' : 'success',
            title: t('Sicherung geschrieben'),
            message: view.fileName ? `${view.subject ?? ''}/${view.fileName}` : (view.subject ?? ''),
          };
    case 'restore':
      return failed
        ? { variant: 'error', title: t('Zurückspielen fehlgeschlagen'), message: failure }
        : {
            variant: view.status === 'warning' ? 'warning' : 'success',
            title: t('Zurückgespielt'),
            message: view.status === 'warning' && view.error ? t(view.error) : (view.subject ?? ''),
          };
    case 'crowdsec':
      // Ein Lauf trägt mehrere Änderungen: die Meldung nennt die gescheiterte, der Grund steht im Fenster.
      return failed
        ? {
            variant: 'error',
            title: t('CrowdSec-Regeln: Änderung fehlgeschlagen'),
            message: failedStep ? t('Fehlgeschlagen bei: {step}', { step: t(failedStep.label) }) : failure,
          }
        : {
            variant: 'success',
            title: t('CrowdSec-Regeln geändert'),
            message: t('CrowdSec hat die Regeln neu geladen.'),
          };
    default:
      return failed
        ? { variant: 'error', title: ref.label ?? view.subject ?? t('Reverse-Proxy'), message: failure }
        : {
            variant: view.status === 'warning' ? 'warning' : 'success',
            title: ref.label ?? view.subject ?? t('Reverse-Proxy'),
            message: t('Durchgelaufen, HAProxy hat die neue Konfiguration übernommen.'),
          };
  }
}
