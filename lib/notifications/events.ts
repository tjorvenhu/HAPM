/**
 * Die Ereignisse, zu denen HAPM eine Mail verschickt.
 *
 * Rein: nur Typen und Tabellen. Die Seite „Benachrichtigungen" liest hier die
 * Namen und Sätze, `notify` die Sache, für die ein Ereignis gilt, und wie
 * lange es danach schweigt.
 */

import type { HaproxyAction, NotificationEventType, UpdateComponent } from '../types';

export interface ExpiringCertificate {
  mainDomain: string;
  /** Aus dem PEM, das HAProxy lädt. */
  expiresAt: string;
  /** Ganze Tage bis zum Ablauf, abgerundet. Negativ heißt abgelaufen. */
  daysLeft: number;
}

export type TargetKind = 'service' | 'stream';

export type NotificationEvent =
  | { type: 'certificate_renewal_failed'; output: string }
  | { type: 'certificate_expiring'; certificates: ExpiringCertificate[] }
  | {
      type: 'backend_down';
      kind: TargetKind;
      id: string;
      /** Domains eines Ziels, bei einer Weiterleitung der Port. */
      addresses: string[];
      /** Die Ziele des Eintrags, wie sie in der Konfiguration stehen. */
      targets: string[];
      /** Seit wann es bei den Prüfungen so ist. */
      since: string;
    }
  | {
      type: 'backend_recovered';
      kind: TargetKind;
      id: string;
      addresses: string[];
      /** Wie viele der geprüften Ziele antworten. */
      up: number;
      total: number;
      /** Wann der Ausfall gemeldet wurde. `null`, wenn es nicht mehr bekannt ist. */
      downSince: string | null;
    }
  | {
      type: 'haproxy_down';
      container: string;
      /** `false`: es gibt den Container nicht. */
      exists: boolean;
      /** Der Zustand, wie Docker ihn nennt, etwa `exited`. */
      status: string | null;
      since: string;
    }
  | {
      type: 'run_failed';
      action: HaproxyAction;
      /** Name des Eintrags, der Weiterleitung oder der Gruppe. */
      entry: string;
      addresses: string | null;
      error: string;
      triggeredBy: string | null;
    }
  | {
      type: 'update_available';
      component: UpdateComponent;
      currentVersion: string | null;
      latestVersion: string | null;
      latestDigest: string | null;
    }
  | {
      type: 'update_completed';
      component: UpdateComponent;
      runId: string;
      fromVersion: string | null;
      toVersion: string | null;
      triggeredBy: string | null;
    }
  | {
      type: 'update_failed';
      component: UpdateComponent;
      fromVersion: string | null;
      error: string;
      triggeredBy: string | null;
    }
  | { type: 'backup_failed'; detail: string };

export interface NotificationEventInfo {
  type: NotificationEventType;
  label: string;
  /** Ein Satz: wann die Mail kommt. */
  description: string;
}

export interface NotificationEventGroup {
  title: string;
  events: NotificationEventInfo[];
}

/** Die Ereignisse in der Reihenfolge und Gliederung der Seite „Benachrichtigungen". */
export const NOTIFICATION_EVENT_GROUPS: NotificationEventGroup[] = [
  {
    title: 'Zertifikate',
    events: [
      {
        type: 'certificate_renewal_failed',
        label: 'Erneuerung gescheitert',
        description: 'Der tägliche Lauf von acme.sh meldet einen Fehler.',
      },
      {
        type: 'certificate_expiring',
        label: 'Zertifikat läuft ab',
        description: 'Ein Zertifikat ist weniger als 14 Tage gültig. Einmal am Tag.',
      },
    ],
  },
  {
    title: 'Reverse-Proxy',
    events: [
      {
        type: 'haproxy_down',
        label: 'HAProxy läuft nicht',
        description: 'Der Container von HAProxy läuft bei zwei Prüfungen in Folge nicht.',
      },
      {
        type: 'backend_down',
        label: 'Kein Ziel antwortet',
        description: 'Kein Ziel eines Eintrags antwortet, bei zwei Prüfungen in Folge.',
      },
      {
        type: 'backend_recovered',
        label: 'Ziele antworten wieder',
        description: 'Ein Eintrag, dessen Ausfall gemeldet wurde, antwortet wieder.',
      },
      {
        type: 'run_failed',
        label: 'Vorgang gescheitert',
        description: 'Ein Vorgang am Reverse-Proxy endet mit einem Fehler.',
      },
    ],
  },
  {
    title: 'Updates und Sicherung',
    events: [
      {
        type: 'update_available',
        label: 'Update verfügbar',
        description: 'Die Prüfung findet eine neue Fassung. Einmal je Fassung.',
      },
      {
        type: 'update_completed',
        label: 'Update eingespielt',
        description: 'Ein Update ist ohne Fehler durchgelaufen.',
      },
      {
        type: 'update_failed',
        label: 'Update gescheitert',
        description: 'Ein Update endet mit einem Fehler.',
      },
      {
        type: 'backup_failed',
        label: 'Sicherung gescheitert',
        description: 'Eine Sicherung endet mit einem Fehler.',
      },
    ],
  },
];

export const NOTIFICATION_EVENT_LABELS = Object.fromEntries(
  NOTIFICATION_EVENT_GROUPS.flatMap((group) => group.events.map((event) => [event.type, event.label]))
) as Record<NotificationEventType, string>;

/**
 * Die Sache, für die ein Ereignis gilt. Ereignis und Sache zusammen sind der
 * Schlüssel der Dämpfung: zwei Einträge, die ausfallen, sind zwei Meldungen,
 * ein Eintrag, der zehnmal ausfällt, ist eine.
 */
export function eventSubject(event: NotificationEvent): string {
  switch (event.type) {
    case 'certificate_renewal_failed':
      return 'acme';
    // Eine Mail für alle fälligen Zertifikate: fällt die Erneuerung aus, sind es meist alle zugleich.
    case 'certificate_expiring':
      return 'certificates';
    case 'backend_down':
    case 'backend_recovered':
      return `${event.kind}:${event.id}`;
    case 'haproxy_down':
      return event.container;
    case 'run_failed':
      return event.entry;
    case 'update_available':
      return `${event.component}:${event.latestDigest ?? event.latestVersion ?? 'unbekannt'}`;
    // Jeder gelungene Lauf ist eine eigene Sache und wird gemeldet.
    case 'update_completed':
      return `${event.component}:${event.runId}`;
    case 'update_failed':
      return event.component;
    case 'backup_failed':
      return 'backup';
  }
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Wie lange dasselbe Ereignis für dieselbe Sache schweigt: einen Tag.
 *
 * Gerechnet wird mit 23 Stunden. Was täglich geprüft wird (Erneuerung, Ablauf,
 * ein selbsttätiges Update), ist nie auf die Sekunde gleich schnell fertig. Mit
 * vollen 24 Stunden fiele jede Meldung weg, deren Lauf heute eine Minute
 * schneller war als gestern, und es käme nur jeden zweiten Tag eine.
 */
export const REPEAT_AFTER_MS = 23 * HOUR_MS;

/** So lange bleibt stehen, was verschickt wurde. Danach gilt eine Sache als neu. */
export const STATE_RETENTION_DAYS = 180;

export function repeatAfterMs(type: NotificationEventType): number {
  // Einmal je Fassung: der Schlüssel trägt die Fassung, wiederholt wird nicht.
  return type === 'update_available' ? Number.POSITIVE_INFINITY : REPEAT_AFTER_MS;
}

export type DeliveryDecision = 'send' | 'disabled' | 'no_recipients' | 'not_configured' | 'dampened';

/**
 * Ob für ein Ereignis jetzt eine Mail rausgeht. Die Reihenfolge ist die, in der
 * die Oberfläche es erklärt: erst der Schalter, dann die Empfänger, dann das
 * Konto, zuletzt die Dämpfung.
 */
export function deliveryDecision(input: {
  enabled: boolean;
  recipients: number;
  configured: boolean;
  lastSentAt: string | null;
  now: number;
  repeatAfterMs: number;
}): DeliveryDecision {
  if (!input.enabled) return 'disabled';
  if (input.recipients === 0) return 'no_recipients';
  if (!input.configured) return 'not_configured';
  if (input.lastSentAt) {
    const last = Date.parse(input.lastSentAt);
    if (!Number.isNaN(last) && input.now - last < input.repeatAfterMs) return 'dampened';
  }
  return 'send';
}
