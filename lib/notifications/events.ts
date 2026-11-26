/**
 * Die Ereignisse, zu denen HAPM eine Mail verschickt.
 *
 * Rein: nur Typen und Tabellen. Die Seite „Benachrichtigungen" liest hier die
 * Namen und Sätze (Schlüssel, `msgid`: die Seite zeigt sie mit `t()`), `notify` die Sache, für die ein Ereignis gilt, und wie
 * lange es danach schweigt.
 */

import { msgid } from '../i18n';
import type { HaproxyAction, NotificationEventType, UpdateComponent } from '../types';
import type { CountRow } from '../crowdsec/data';

export interface ExpiringCertificate {
  mainDomain: string;
  /** Aus dem PEM, das HAProxy lädt. */
  expiresAt: string;
  /** Ganze Tage bis zum Ablauf, abgerundet. Negativ heißt abgelaufen. */
  daysLeft: number;
  /** Hochgeladen: niemand erneuert es von selbst. Fehlt es (ältere Zeile), von acme.sh. */
  uploaded?: boolean;
}

/** Eine hinterlegte Zertifizierungsstelle (`lib/haproxy/backend-ca.ts`), die ein Ziel benutzt und bald abläuft. */
export interface ExpiringAuthority {
  name: string;
  /** Der früheste Ablauf unter den Zertifikaten der Datei. */
  expiresAt: string;
  /** Ganze Tage bis zum Ablauf, abgerundet. Negativ heißt abgelaufen. */
  daysLeft: number;
  /** Die Ziele, die gegen sie prüfen: sie sind es, die nach dem Ablauf ausfallen. */
  usedBy: string[];
}

export type TargetKind = 'service' | 'stream';

export type NotificationEvent =
  | { type: 'certificate_renewal_failed'; output: string }
  | { type: 'certificate_expiring'; certificates: ExpiringCertificate[] }
  | { type: 'backend_ca_expiring'; authorities: ExpiringAuthority[] }
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
  | { type: 'backup_failed'; detail: string }
  | {
      type: 'crowdsec_down';
      /** `bouncer`: HAProxy erreicht niemanden, der fragt. `crowdsec`: niemand prüft. */
      role: 'crowdsec' | 'bouncer';
      container: string;
      exists: boolean;
      status: string | null;
      since: string;
      /** `true`: alle Ziele, sonst die Zahl der Ziele mit eigenem Schalter. */
      global: boolean;
      protectedServices: number;
    }
  | {
      type: 'crowdsec_report';
      from: string;
      to: string;
      totals: { alerts: number; waf: number; scenario: number; manual: number; sources: number };
      /** Jetzt aktive Sperren. `null`: nicht zu erfahren. */
      activeDecisions: number | null;
      scenarios: CountRow[];
      sources: CountRow[];
      targets: CountRow[];
    };

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
    title: msgid('Zertifikate'),
    events: [
      {
        type: 'certificate_renewal_failed',
        label: msgid('Erneuerung gescheitert'),
        description: msgid('Der tägliche Lauf von acme.sh meldet einen Fehler.'),
      },
      {
        type: 'certificate_expiring',
        label: msgid('Zertifikat läuft ab'),
        description: msgid('Unter 14 Tage gültig, ein hochgeladenes unter 30. Einmal am Tag.'),
      },
      {
        type: 'backend_ca_expiring',
        label: msgid('Zertifizierungsstelle läuft ab'),
        description: msgid('Eine hinterlegte, die ein Ziel benutzt, unter 30 Tage gültig.'),
      },
    ],
  },
  {
    title: msgid('Reverse-Proxy'),
    events: [
      {
        type: 'haproxy_down',
        label: msgid('HAProxy läuft nicht'),
        description: msgid('Der Container von HAProxy läuft bei zwei Prüfungen in Folge nicht.'),
      },
      {
        type: 'backend_down',
        label: msgid('Kein Ziel antwortet'),
        description: msgid('Kein Ziel eines Eintrags antwortet, bei zwei Prüfungen in Folge.'),
      },
      {
        type: 'backend_recovered',
        label: msgid('Ziele antworten wieder'),
        description: msgid('Ein Eintrag, dessen Ausfall gemeldet wurde, antwortet wieder.'),
      },
      {
        type: 'run_failed',
        label: msgid('Vorgang gescheitert'),
        description: msgid('Ein Vorgang am Reverse-Proxy endet mit einem Fehler.'),
      },
    ],
  },
  {
    title: msgid('Updates und Sicherung'),
    events: [
      {
        type: 'update_available',
        label: msgid('Update verfügbar'),
        description: msgid('Die Prüfung findet eine neue Fassung. Einmal je Fassung.'),
      },
      {
        type: 'update_completed',
        label: msgid('Update eingespielt'),
        description: msgid('Ein Update ist ohne Fehler durchgelaufen.'),
      },
      {
        type: 'update_failed',
        label: msgid('Update gescheitert'),
        description: msgid('Ein Update endet mit einem Fehler.'),
      },
      {
        type: 'backup_failed',
        label: msgid('Sicherung gescheitert'),
        description: msgid('Eine Sicherung endet mit einem Fehler.'),
      },
    ],
  },
  {
    title: 'CrowdSec',
    events: [
      {
        type: 'crowdsec_down',
        label: msgid('CrowdSec prüft nicht'),
        description: msgid('CrowdSec oder Bouncer läuft nicht, Anfragen gehen ungeprüft durch.'),
      },
      {
        type: 'crowdsec_report',
        label: msgid('Tagesbericht'),
        description: msgid('Einmal am Tag, was CrowdSec erkannt hat. Nur, wenn etwas war.'),
      },
    ],
  },
];

/** Die Gruppe, die nur zeigt, wo CrowdSec installiert ist. */
export const CROWDSEC_EVENT_TYPES: readonly NotificationEventType[] = ['crowdsec_down', 'crowdsec_report'];

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
    // Wie bei den Zertifikaten: eine Mail für alle, die fällig sind.
    case 'backend_ca_expiring':
      return 'authorities';
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
    case 'crowdsec_down':
      return event.container;
    // Einer am Tag; die Dämpfung von 23 Stunden fängt einen zweiten Lauf ab.
    case 'crowdsec_report':
      return 'report';
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
  if (type === 'update_available') return Number.POSITIVE_INFINITY;
  // Die Entwarnung kommt je gemeldetem Ausfall genau einmal (`resolveState` in
  // `checks.ts`). Eine zweite Dämpfung verschluckte sie, wenn derselbe Eintrag
  // an zwei Tagen kurz nacheinander ausfällt: die Ausfallmail kündigt sie an.
  if (type === 'backend_recovered') return 0;
  return REPEAT_AFTER_MS;
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
