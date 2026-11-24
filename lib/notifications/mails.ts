/**
 * Was in welcher Benachrichtigung steht.
 *
 * Rein: aus einem Ereignis wird Betreff, HTML und Text, ohne Einstellungen zu
 * lesen und ohne etwas zu verschicken. Jede Mail sagt im Betreff, was los ist,
 * und im Text was, wo, seit wann und was zu tun ist. Der Knopf in die
 * Oberfläche steht nur da, wenn die Adresse von HAPM eingerichtet ist.
 *
 * Behauptet wird nur, was HAPM an dieser Stelle weiß. „Es wurde nichts
 * geändert" steht in einer Mail nur, wenn der Lauf selbst es so meldet.
 */

import {
  escapeHtml,
  escapeMultiline,
  mailFacts,
  mailNote,
  mailText,
  renderHapmMail,
  type MailAction,
  type MailFact,
  type MailInstallation,
} from '../mail/layout';
import { CERT_WARN_DAYS } from '../system/certificates';
import type { HaproxyAction, UpdateComponent } from '../types';
import type { ExpiringCertificate, NotificationEvent, TargetKind } from './events';

export interface NotificationMailContext extends MailInstallation {
  now: Date;
  /** Ob „Ziele antworten wieder" eingeschaltet ist: nur dann kündigt die Ausfallmail es an. */
  recoveryEnabled: boolean;
  autoUpdateHaproxy: boolean;
  autoUpdateTime: string;
}

export interface NotificationMail {
  subject: string;
  html: string;
  text: string;
}

const COMPONENT_LABELS: Record<UpdateComponent, string> = {
  haproxy: 'HAProxy',
  hapm: 'HAPM',
  acme: 'acme.sh',
};

const RUN_ACTION_LABELS: Record<HaproxyAction, string> = {
  create: 'Eintrag anlegen',
  update: 'Eintrag ändern',
  delete: 'Eintrag entfernen',
  settings: 'Globale Einstellungen ändern',
  'scope-add': 'Gruppe anlegen',
  'scope-remove': 'Gruppe entfernen',
  'stream-create': 'Weiterleitung anlegen',
  'stream-update': 'Weiterleitung ändern',
  'stream-delete': 'Weiterleitung entfernen',
  certificate: 'Zertifikat ausstellen',
};

function formatWhen(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return 'unbekannt';
  const day = date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const time = date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return `${day}, ${time} Uhr`;
}

function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unbekannt';
  return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** „2 Stunden 5 Minuten". Unter einer Minute steht keine Zahl. */
function formatDuration(milliseconds: number): string {
  const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);
  if (minutes < 1) return 'unter einer Minute';
  const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return hours > 0 ? `${plural(days, 'Tag', 'Tage')} ${plural(hours, 'Stunde', 'Stunden')}` : plural(days, 'Tag', 'Tage');
  if (hours > 0) return rest > 0 ? `${plural(hours, 'Stunde', 'Stunden')} ${plural(rest, 'Minute', 'Minuten')}` : plural(hours, 'Stunde', 'Stunden');
  return plural(rest, 'Minute', 'Minuten');
}

/** Ausgabe einer Maschine: gekürzt auf das Ende, dort steht der Fehler. Umbrüche bleiben. */
function machineTail(value: string, limit = 1500): string {
  const text = value.trim();
  return escapeMultiline(text.length > limit ? `[...]\n${text.slice(-limit)}` : text || 'Keine Ausgabe.');
}

/** Eine Fehlermeldung: gekürzt auf den Anfang. */
function machineHead(value: string, limit = 1000): string {
  const text = value.trim();
  return escapeMultiline(text.length > limit ? `${text.slice(0, limit)}\n[...]` : text || 'Keine Meldung.');
}

const strong = (value: string) => `<strong>${escapeHtml(value)}</strong>`;
const code = (value: string) => `<code>${escapeHtml(value)}</code>`;

function triggeredByLabel(value: string | null): string {
  if (!value) return 'unbekannt';
  return value === 'scheduler' ? 'Zeitplan' : value;
}

interface Draft {
  subject: string;
  eyebrow: string;
  heading: string;
  body: string;
  /** Beschriftung und Pfad in der Oberfläche. */
  action?: { label: string; path: string };
}

function certificateState(cert: ExpiringCertificate): string {
  if (cert.daysLeft < 0) return `seit dem ${formatDay(cert.expiresAt)} abgelaufen`;
  if (cert.daysLeft === 0) return `läuft am ${formatDay(cert.expiresAt)} ab, in weniger als 24 Stunden`;
  return `läuft am ${formatDay(cert.expiresAt)} ab, in ${cert.daysLeft === 1 ? 'einem Tag' : `${cert.daysLeft} Tagen`}`;
}

function certificateSubject(certificates: ExpiringCertificate[]): string {
  const expired = certificates.filter((cert) => cert.daysLeft < 0).length;
  if (certificates.length === 1) {
    const [cert] = certificates;
    if (cert.daysLeft < 0) return `Zertifikat für ${cert.mainDomain} ist abgelaufen`;
    if (cert.daysLeft === 0) return `Zertifikat für ${cert.mainDomain} läuft in weniger als 24 Stunden ab`;
    return `Zertifikat für ${cert.mainDomain} läuft in ${cert.daysLeft === 1 ? 'einem Tag' : `${cert.daysLeft} Tagen`} ab`;
  }
  if (expired === certificates.length) return `${expired} Zertifikate sind abgelaufen`;
  if (expired > 0) return `${certificates.length} Zertifikate laufen ab, ${expired} davon ${expired === 1 ? 'ist' : 'sind'} abgelaufen`;
  return `${certificates.length} Zertifikate laufen in weniger als ${CERT_WARN_DAYS} Tagen ab`;
}

function targetName(kind: TargetKind, id: string, addresses: string[]): string {
  if (kind === 'stream') return addresses[0] ? `Weiterleitung ${id} (${addresses[0]})` : `Weiterleitung ${id}`;
  return addresses[0] ?? id;
}

function targetFacts(kind: TargetKind, id: string, addresses: string[]): MailFact[] {
  return [
    { label: kind === 'stream' ? 'Weiterleitung' : 'Eintrag', value: id },
    ...(addresses.length > 0
      ? [{ label: kind === 'stream' ? 'Erreichbar über' : 'Domains', value: addresses.join(', ') }]
      : []),
  ];
}

function draft(event: NotificationEvent, ctx: NotificationMailContext): Draft {
  const node = strong(ctx.nodeName);

  switch (event.type) {
    case 'certificate_renewal_failed':
      return {
        subject: 'Erneuerung der Zertifikate gescheitert',
        eyebrow: 'Zertifikate',
        heading: 'Erneuerung der Zertifikate gescheitert',
        body:
          mailText(
            `Der tägliche Lauf von acme.sh auf ${node} hat am ${formatWhen(ctx.now)} einen Fehler gemeldet. Die vorhandenen Zertifikate gelten weiter, bis sie ablaufen.`
          ) +
          mailNote(machineTail(event.output), 'danger', 'Ausgabe von acme.sh') +
          mailText(
            'Was zu tun ist: In der Ausgabe steht, an welcher Domain es lag. Häufige Ursachen sind ein DNS-Eintrag, der nicht mehr auf diesen Server zeigt, und ein abgelaufenes Token für die DNS-Prüfung. Der nächste Lauf ist morgen.'
          ),
        action: { label: 'Zertifikate ansehen', path: '/reverse-proxy/zertifikate' },
      };

    case 'certificate_expiring': {
      const certificates = [...event.certificates].sort((a, b) => a.daysLeft - b.daysLeft);
      const subject = certificateSubject(certificates);
      return {
        subject,
        eyebrow: 'Zertifikate',
        heading: certificates.length === 1 ? subject : 'Zertifikate laufen ab',
        body:
          mailText(
            certificates.length === 1
              ? `Auf ${node} ist ein Zertifikat weniger als ${CERT_WARN_DAYS} Tage gültig oder schon abgelaufen.`
              : `Auf ${node} sind ${certificates.length} Zertifikate weniger als ${CERT_WARN_DAYS} Tage gültig oder schon abgelaufen.`
          ) +
          mailFacts(
            certificates.map((cert) => ({ label: cert.mainDomain, value: certificateState(cert) })),
            { stacked: true }
          ) +
          mailText(
            'Was zu tun ist: acme.sh erneuert Zertifikate von selbst vor dem Ablauf. Steht eines hier, ist das bisher nicht gelungen. Die Ausgabe der letzten Erneuerung steht in der Übersicht. Nach dem Ablauf zeigen Browser für die Domain eine Warnung.'
          ),
        action: { label: 'Zertifikate ansehen', path: '/reverse-proxy/zertifikate' },
      };
    }

    case 'backend_down': {
      const name = targetName(event.kind, event.id, event.addresses);
      return {
        subject: `${name}: kein Ziel antwortet`,
        eyebrow: 'Reverse-Proxy',
        heading: 'Kein Ziel antwortet',
        body:
          mailText(
            event.kind === 'stream'
              ? `Für die Weiterleitung ${strong(event.id)} auf ${node} antwortet kein Ziel mehr auf die Prüfung von HAProxy. Verbindungen über diese Weiterleitung kommen nicht zustande.`
              : `Für den Eintrag ${strong(event.id)} auf ${node} antwortet kein Ziel mehr auf die Prüfung von HAProxy. Anfragen an seine Domains bekommen eine Fehlerseite.`
          ) +
          mailFacts([
            ...targetFacts(event.kind, event.id, event.addresses),
            ...(event.targets.length > 0 ? [{ label: 'Ziele', value: event.targets.join(', ') }] : []),
            { label: 'Seit', value: formatWhen(event.since) },
          ]) +
          mailText(
            'Was zu tun ist: Prüfen, ob der Dienst auf dem Ziel läuft und von diesem Server aus erreichbar ist.' +
              (ctx.recoveryEnabled ? ' Sobald wieder ein Ziel antwortet, kommt eine zweite Mail.' : '')
          ),
        action: { label: 'Ziele ansehen', path: '/reverse-proxy' },
      };
    }

    case 'backend_recovered': {
      const name = targetName(event.kind, event.id, event.addresses);
      const all = event.up === event.total;
      const downSince = event.downSince ? Date.parse(event.downSince) : Number.NaN;
      return {
        subject: all ? `${name}: Ziele antworten wieder` : `${name}: ein Teil der Ziele antwortet wieder`,
        eyebrow: 'Reverse-Proxy',
        heading: all ? 'Ziele antworten wieder' : 'Ein Teil der Ziele antwortet wieder',
        body:
          mailText(
            `${event.kind === 'stream' ? 'Die Weiterleitung' : 'Der Eintrag'} ${strong(event.id)} auf ${node} ist wieder erreichbar.`
          ) +
          mailFacts([
            ...targetFacts(event.kind, event.id, event.addresses),
            { label: 'Ziele, die antworten', value: `${event.up} von ${event.total}`, tone: all ? 'accent' : undefined },
            ...(Number.isNaN(downSince)
              ? []
              : [
                  { label: 'Ausfall gemeldet', value: formatWhen(event.downSince as string) },
                  { label: 'Dauer seit der Meldung', value: formatDuration(ctx.now.getTime() - downSince) },
                ]),
          ]) +
          (all ? '' : mailNote('Die übrigen Ziele antworten noch nicht.', 'warning')),
        action: { label: 'Ziele ansehen', path: '/reverse-proxy' },
      };
    }

    case 'haproxy_down':
      return {
        subject: 'HAProxy läuft nicht',
        eyebrow: 'Reverse-Proxy',
        heading: 'HAProxy läuft nicht',
        body:
          mailText(
            `Der Container ${code(event.container)} auf ${node} läuft nicht. Solange er nicht läuft, ist über diesen Server keine Domain und keine Weiterleitung erreichbar.`
          ) +
          mailFacts([
            {
              label: 'Zustand',
              value: event.exists ? (event.status ?? 'unbekannt') : 'Der Container existiert nicht',
            },
            { label: 'Seit', value: formatWhen(event.since) },
          ]) +
          mailText(
            event.exists
              ? `Was zu tun ist: Auf dem Server zeigt ${code(`docker logs ${event.container}`)}, warum er beendet wurde. ${code(`docker start ${event.container}`)} startet ihn wieder.`
              : `Was zu tun ist: Auf dem Server legt ${code('docker compose up -d')} im Ordner der Installation den Container wieder an.`
          ) +
          mailText(
            'Läuft die Oberfläche von HAPM über HAProxy, ist sie so lange nur direkt über den Port von HAPM erreichbar.'
          ),
      };

    case 'run_failed': {
      const action = RUN_ACTION_LABELS[event.action] ?? event.action;
      return {
        subject:
          event.action === 'settings' ? `Vorgang gescheitert: ${action}` : `Vorgang gescheitert: ${action} (${event.entry})`,
        eyebrow: 'Reverse-Proxy',
        heading: 'Vorgang am Reverse-Proxy gescheitert',
        body:
          mailText(`Ein Vorgang am Reverse-Proxy auf ${node} ist mit einem Fehler zu Ende gegangen.`) +
          mailFacts([
            { label: 'Vorgang', value: action },
            ...(event.action === 'settings' ? [] : [{ label: 'Name', value: event.entry }]),
            ...(event.addresses ? [{ label: 'Adressen', value: event.addresses }] : []),
            { label: 'Ausgelöst von', value: triggeredByLabel(event.triggeredBy) },
            { label: 'Zeitpunkt', value: formatWhen(ctx.now) },
          ]) +
          mailNote(machineHead(event.error), 'danger', 'Fehler') +
          mailText('Was zu tun ist: Unter „Logs“ steht der Vorgang mit jedem Schritt und dessen Ergebnis.'),
        action: { label: 'Vorgänge ansehen', path: '/reverse-proxy/logs' },
      };
    }

    case 'update_available': {
      const label = COMPONENT_LABELS[event.component];
      const newVersion = event.latestVersion && event.latestVersion !== event.currentVersion ? event.latestVersion : null;
      const automatic = event.component === 'haproxy' && ctx.autoUpdateHaproxy;
      return {
        subject: newVersion ? `Update verfügbar: ${label} ${newVersion}` : `Update verfügbar: neues Abbild für ${label}`,
        eyebrow: 'Updates',
        heading: `Update für ${label} verfügbar`,
        body:
          mailText(`Für ${strong(label)} auf ${node} gibt es eine neue Fassung.`) +
          mailFacts([
            { label: 'Läuft', value: event.currentVersion ?? 'Version unbekannt' },
            { label: 'Verfügbar', value: newVersion ?? 'Neues Abbild derselben Fassung', tone: 'accent' },
          ]) +
          mailText(
            automatic
              ? `HAProxy wird um ${escapeHtml(ctx.autoUpdateTime)} Uhr selbsttätig aktualisiert. Unter „Updates“ geht es auch sofort.`
              : 'Eingespielt wird es unter „Updates“. Von selbst geschieht nichts.'
          ),
        action: { label: 'Updates ansehen', path: '/updates' },
      };
    }

    case 'update_completed': {
      const label = COMPONENT_LABELS[event.component];
      const changed = Boolean(event.toVersion && event.toVersion !== event.fromVersion);
      return {
        subject: changed ? `${label} aktualisiert auf ${event.toVersion}` : `Update von ${label} durchgelaufen`,
        eyebrow: 'Updates',
        heading: changed ? `${label} aktualisiert` : `Update von ${label} durchgelaufen`,
        body:
          mailText(`Das Update von ${strong(label)} auf ${node} ist ohne Fehler durchgelaufen.`) +
          mailFacts([
            { label: 'Vorher', value: event.fromVersion ?? 'Version unbekannt' },
            { label: 'Jetzt', value: event.toVersion ?? 'Version unbekannt', tone: changed ? 'accent' : undefined },
            { label: 'Ausgelöst von', value: triggeredByLabel(event.triggeredBy) },
            { label: 'Abgeschlossen', value: formatWhen(ctx.now) },
          ]) +
          (changed
            ? ''
            : mailText(
                'Die Versionsnummer ist dieselbe geblieben: Entweder lief schon das neueste Abbild, oder das neue trägt dieselbe Nummer. Die Schritte des Laufs stehen unter „Updates“.'
              )),
        action: { label: 'Updates ansehen', path: '/updates' },
      };
    }

    case 'update_failed': {
      const label = COMPONENT_LABELS[event.component];
      return {
        subject: `Update von ${label} gescheitert`,
        eyebrow: 'Updates',
        heading: `Update von ${label} gescheitert`,
        body:
          mailText(`Das Update von ${strong(label)} auf ${node} ist mit einem Fehler zu Ende gegangen.`) +
          mailFacts([
            { label: 'Fassung vor dem Update', value: event.fromVersion ?? 'Version unbekannt' },
            { label: 'Ausgelöst von', value: triggeredByLabel(event.triggeredBy) },
            { label: 'Zeitpunkt', value: formatWhen(ctx.now) },
          ]) +
          mailNote(machineHead(event.error), 'danger', 'Fehler') +
          mailText('Was zu tun ist: Unter „Updates“ steht der Lauf in der Historie, mit jedem Schritt und dessen Ausgabe.'),
        action: { label: 'Updates ansehen', path: '/updates' },
      };
    }

    case 'backup_failed':
      return {
        subject: 'Sicherung gescheitert',
        eyebrow: 'Sicherung',
        heading: 'Sicherung gescheitert',
        body:
          mailText(`Die Sicherung von HAPM auf ${node} ist am ${formatWhen(ctx.now)} gescheitert.`) +
          mailNote(machineHead(event.detail), 'danger', 'Fehler') +
          mailText('Was zu tun ist: Unter „Sicherung“ steht, was eingestellt ist und wie der letzte Lauf ausging.'),
        action: { label: 'Sicherung ansehen', path: '/backup' },
      };
  }
}

export const NOTIFICATION_FOOTER_NOTE = 'Welche Ereignisse eine Mail auslösen, steht in HAPM unter „Benachrichtigungen“.';

export function notificationMail(event: NotificationEvent, ctx: NotificationMailContext): NotificationMail {
  const content = draft(event, ctx);
  const action: MailAction | undefined =
    content.action && ctx.publicUrl ? { label: content.action.label, url: `${ctx.publicUrl}${content.action.path}` } : undefined;

  const rendered = renderHapmMail(
    {
      subject: content.subject,
      eyebrow: content.eyebrow,
      heading: content.heading,
      body: content.body,
      action,
      footerNote: NOTIFICATION_FOOTER_NOTE,
    },
    { nodeName: ctx.nodeName, publicUrl: ctx.publicUrl }
  );
  return { subject: content.subject, ...rendered };
}

/** Die Testmail von der Seite „Benachrichtigungen". */
export function testMail(installation: MailInstallation): NotificationMail {
  const subject = 'Testmail von HAPM';
  const rendered = renderHapmMail(
    {
      subject,
      eyebrow: 'Benachrichtigungen',
      heading: 'Der Versand funktioniert',
      body:
        mailText(
          `Diese Mail hat HAPM auf ${strong(installation.nodeName)} über das eingerichtete SMTP-Konto verschickt. Kommt sie an, stimmen Server, Anmeldung und Absender.`
        ) +
        mailText('Wer sie bekommt und zu welchen Ereignissen, steht unter „Benachrichtigungen“.'),
      action: installation.publicUrl
        ? { label: 'Benachrichtigungen öffnen', url: `${installation.publicUrl}/notifications` }
        : undefined,
    },
    installation
  );
  return { subject, ...rendered };
}
