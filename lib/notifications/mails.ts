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
 *
 * Die Sprache kommt mit dem Kontext (`ctx.locale`, die Einstellung „Sprache der
 * Mails"). Alles, was die Mail selbst schreibt, geht durch `t()`, Datum und
 * Zahlen durch `lib/i18n/format.ts`. Was von außen kommt (Ausgabe von acme.sh,
 * Fehlermeldungen eines Laufs, Namen), bleibt, wie es ist.
 */

import { createTranslator, formatCount, formatDate, formatDateTime, msgid, type Translator } from '../i18n';
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
import { CERT_WARN_DAYS, UPLOAD_WARN_DAYS } from '../system/certificates';
import { CA_WARN_DAYS } from '../haproxy/backend-ca';
import type { HaproxyAction, UpdateComponent } from '../types';
import type { ExpiringAuthority, ExpiringCertificate, NotificationEvent, TargetKind } from './events';

export interface NotificationMailContext extends MailInstallation {
  now: Date;
  /** Ob „Ziele antworten wieder" eingeschaltet ist: nur dann kündigt die Ausfallmail es an. */
  recoveryEnabled: boolean;
  autoUpdateHaproxy: boolean;
  /** Was selbsttätig aktualisiert wird. Fehlt es, gilt `autoUpdateHaproxy` für HAProxy. */
  autoUpdate?: UpdateComponent[];
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
  crowdsec: 'CrowdSec',
  'crowdsec-bouncer': 'CrowdSec-Bouncer',
};

const RUN_ACTION_LABELS: Record<HaproxyAction, string> = {
  create: msgid('Eintrag anlegen'),
  update: msgid('Eintrag ändern'),
  delete: msgid('Eintrag entfernen'),
  settings: msgid('Globale Einstellungen ändern'),
  'scope-add': msgid('Gruppe anlegen'),
  'scope-remove': msgid('Gruppe entfernen'),
  'stream-create': msgid('Weiterleitung anlegen'),
  'stream-update': msgid('Weiterleitung ändern'),
  'stream-delete': msgid('Weiterleitung entfernen'),
  certificate: msgid('Zertifikat ausstellen'),
  import: msgid('Konfiguration importieren'),
};

export const NOTIFICATION_FOOTER_NOTE = msgid('Welche Ereignisse eine Mail auslösen, steht in HAPM unter „Benachrichtigungen“.');

/** Was eine Mail zum Schreiben braucht: die Übersetzung und die Formate in ihrer Sprache. */
interface Writer extends Translator {
  when: (value: Date | string) => string;
  day: (iso: string) => string;
  duration: (milliseconds: number) => string;
}

function writer(ctx: Pick<MailInstallation, 'locale'>): Writer {
  const translator = createTranslator(ctx.locale);
  const { t, plural, locale } = translator;
  return {
    ...translator,
    when: (value) => {
      const date = typeof value === 'string' ? new Date(value) : value;
      if (Number.isNaN(date.getTime())) return t('unbekannt');
      return t('{when} Uhr', { when: formatDateTime(locale, date) });
    },
    day: (iso) => (Number.isNaN(new Date(iso).getTime()) ? t('unbekannt') : formatDate(locale, iso)),
    /** „2 Stunden 5 Minuten". Unter einer Minute steht keine Zahl. */
    duration: (milliseconds) => {
      const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);
      if (minutes < 1) return t('unter einer Minute');
      const days = Math.floor(minutes / 1440);
      const hours = Math.floor((minutes % 1440) / 60);
      const rest = minutes % 60;
      const d = plural(days, { one: '{count} Tag', other: '{count} Tage' });
      const h = plural(hours, { one: '{count} Stunde', other: '{count} Stunden' });
      const m = plural(rest, { one: '{count} Minute', other: '{count} Minuten' });
      if (days > 0) return hours > 0 ? `${d} ${h}` : d;
      if (hours > 0) return rest > 0 ? `${h} ${m}` : h;
      return m;
    },
  };
}

/** Ausgabe einer Maschine: gekürzt auf das Ende, dort steht der Fehler. Umbrüche bleiben. */
function machineTail(value: string, w: Writer, limit = 1500): string {
  const text = value.trim();
  return escapeMultiline(text.length > limit ? `[...]\n${text.slice(-limit)}` : text || w.t('Keine Ausgabe.'));
}

/** Eine Fehlermeldung: gekürzt auf den Anfang. */
function machineHead(value: string, w: Writer, limit = 1000): string {
  const text = value.trim();
  return escapeMultiline(text.length > limit ? `${text.slice(0, limit)}\n[...]` : text || w.t('Keine Meldung.'));
}

const strong = (value: string) => `<strong>${escapeHtml(value)}</strong>`;
const code = (value: string) => `<code>${escapeHtml(value)}</code>`;

function triggeredByLabel(value: string | null, w: Writer): string {
  if (!value) return w.t('unbekannt');
  return value === 'scheduler' ? w.t('Zeitplan') : value;
}

interface Draft {
  subject: string;
  eyebrow: string;
  heading: string;
  body: string;
  /** Beschriftung und Pfad in der Oberfläche. */
  action?: { label: string; path: string };
}

function certificateState(cert: Pick<ExpiringCertificate, 'expiresAt' | 'daysLeft'>, w: Writer): string {
  const date = w.day(cert.expiresAt);
  if (cert.daysLeft < 0) return w.t('seit dem {date} abgelaufen', { date });
  if (cert.daysLeft === 0) return w.t('läuft am {date} ab, in weniger als 24 Stunden', { date });
  return w.plural(cert.daysLeft, { one: 'läuft am {date} ab, in einem Tag', other: 'läuft am {date} ab, in {count} Tagen' }, { date });
}

function certificateSubject(certificates: ExpiringCertificate[], w: Writer): string {
  const expired = certificates.filter((cert) => cert.daysLeft < 0).length;
  if (certificates.length === 1) {
    const [cert] = certificates;
    const domain = cert.mainDomain;
    if (cert.daysLeft < 0) return w.t('Zertifikat für {domain} ist abgelaufen', { domain });
    if (cert.daysLeft === 0) return w.t('Zertifikat für {domain} läuft in weniger als 24 Stunden ab', { domain });
    return w.plural(
      cert.daysLeft,
      { one: 'Zertifikat für {domain} läuft in einem Tag ab', other: 'Zertifikat für {domain} läuft in {count} Tagen ab' },
      { domain }
    );
  }
  if (expired === certificates.length) return w.t('{count} Zertifikate sind abgelaufen', { count: expired });
  if (expired > 0) {
    return w.t(
      expired === 1
        ? '{count} Zertifikate laufen ab, {expired} davon ist abgelaufen'
        : '{count} Zertifikate laufen ab, {expired} davon sind abgelaufen',
      { count: certificates.length, expired }
    );
  }
  return w.t('{count} Zertifikate laufen in weniger als {days} Tagen ab', {
    count: certificates.length,
    days: certificates.some((cert) => cert.uploaded) ? UPLOAD_WARN_DAYS : CERT_WARN_DAYS,
  });
}

function authoritySubject(authorities: ExpiringAuthority[], w: Writer): string {
  if (authorities.length === 1) {
    const [ca] = authorities;
    const name = ca.name;
    if (ca.daysLeft < 0) return w.t('Zertifizierungsstelle {name} ist abgelaufen', { name });
    if (ca.daysLeft === 0) return w.t('Zertifizierungsstelle {name} läuft in weniger als 24 Stunden ab', { name });
    return w.plural(
      ca.daysLeft,
      { one: 'Zertifizierungsstelle {name} läuft in einem Tag ab', other: 'Zertifizierungsstelle {name} läuft in {count} Tagen ab' },
      { name }
    );
  }
  return w.t('{count} Zertifizierungsstellen laufen ab', { count: authorities.length });
}

function targetName(kind: TargetKind, id: string, addresses: string[], w: Writer): string {
  if (kind === 'stream') {
    return addresses[0]
      ? w.t('Weiterleitung {id} ({address})', { id, address: addresses[0] })
      : w.t('Weiterleitung {id}', { id });
  }
  return addresses[0] ?? id;
}

function targetFacts(kind: TargetKind, id: string, addresses: string[], w: Writer): MailFact[] {
  return [
    { label: kind === 'stream' ? w.t('Weiterleitung') : w.t('Eintrag'), value: id },
    ...(addresses.length > 0
      ? [{ label: kind === 'stream' ? w.t('Erreichbar über') : w.t('Domains'), value: addresses.join(', ') }]
      : []),
  ];
}

function draft(event: NotificationEvent, ctx: NotificationMailContext, w: Writer): Draft {
  const { t } = w;
  const node = strong(ctx.nodeName);

  switch (event.type) {
    case 'certificate_renewal_failed':
      return {
        subject: t('Erneuerung der Zertifikate gescheitert'),
        eyebrow: t('Zertifikate'),
        heading: t('Erneuerung der Zertifikate gescheitert'),
        body:
          mailText(
            t(
              'Der tägliche Lauf von acme.sh auf {node} hat am {when} einen Fehler gemeldet. Die vorhandenen Zertifikate gelten weiter, bis sie ablaufen.',
              { node, when: w.when(ctx.now) }
            )
          ) +
          mailNote(machineTail(event.output, w), 'danger', t('Ausgabe von acme.sh')) +
          mailText(
            t(
              'Was zu tun ist: In der Ausgabe steht, an welcher Domain es lag. Häufige Ursachen sind ein DNS-Eintrag, der nicht mehr auf diesen Server zeigt, und ein abgelaufenes Token für die DNS-Prüfung. Der nächste Lauf ist morgen.'
            )
          ),
        action: { label: t('Zertifikate ansehen'), path: '/reverse-proxy/zertifikate' },
      };

    case 'certificate_expiring': {
      const certificates = [...event.certificates].sort((a, b) => a.daysLeft - b.daysLeft);
      const subject = certificateSubject(certificates, w);
      const uploaded = certificates.filter((cert) => cert.uploaded);
      // Hochgeladene melden sich früher: die Zahl im Satz ist die größere, sobald eins dabei ist.
      const warnDays = uploaded.length > 0 ? UPLOAD_WARN_DAYS : CERT_WARN_DAYS;
      return {
        subject,
        eyebrow: t('Zertifikate'),
        heading: certificates.length === 1 ? subject : t('Zertifikate laufen ab'),
        body:
          mailText(
            certificates.length === 1
              ? t('Auf {node} ist ein Zertifikat weniger als {days} Tage gültig oder schon abgelaufen.', {
                  node,
                  days: warnDays,
                })
              : t('Auf {node} sind {count} Zertifikate weniger als {days} Tage gültig oder schon abgelaufen.', {
                  node,
                  count: certificates.length,
                  days: warnDays,
                })
          ) +
          mailFacts(
            certificates.map((cert) => ({
              label: cert.mainDomain,
              value: cert.uploaded ? `${certificateState(cert, w)}, ${t('hochgeladen')}` : certificateState(cert, w),
            })),
            { stacked: true }
          ) +
          mailText(
            uploaded.length === certificates.length
              ? t(
                  'Was zu tun ist: hochgeladene Zertifikate erneuert niemand von selbst. Beantragen Sie bei Ihrer CA ein neues und ersetzen Sie das alte unter Reverse-Proxy, Zertifikate. Nach dem Ablauf zeigen Browser für die Domain eine Warnung.'
                )
              : uploaded.length > 0
                ? t(
                    'Was zu tun ist: acme.sh erneuert seine Zertifikate von selbst vor dem Ablauf. Steht eines davon hier, ist das bisher nicht gelungen, die Ausgabe der letzten Erneuerung steht in der Übersicht. Hochgeladene erneuert niemand: ersetzen Sie sie unter Reverse-Proxy, Zertifikate. Nach dem Ablauf zeigen Browser für die Domain eine Warnung.'
                  )
                : t(
                    'Was zu tun ist: acme.sh erneuert Zertifikate von selbst vor dem Ablauf. Steht eines hier, ist das bisher nicht gelungen. Die Ausgabe der letzten Erneuerung steht in der Übersicht. Nach dem Ablauf zeigen Browser für die Domain eine Warnung.'
                  )
          ),
        action: { label: t('Zertifikate ansehen'), path: '/reverse-proxy/zertifikate' },
      };
    }

    case 'backend_ca_expiring': {
      const authorities = [...event.authorities].sort((a, b) => a.daysLeft - b.daysLeft);
      const subject = authoritySubject(authorities, w);
      return {
        subject,
        eyebrow: t('Zertifikate'),
        heading: authorities.length === 1 ? subject : t('Zertifizierungsstellen laufen ab'),
        body:
          mailText(
            t(
              'Auf {node} prüft HAProxy das Zertifikat von Zielen gegen eine hinterlegte Zertifizierungsstelle, die weniger als {days} Tage gültig oder schon abgelaufen ist.',
              { node, days: CA_WARN_DAYS }
            )
          ) +
          mailFacts(
            authorities.map((ca) => ({
              label: ca.name,
              value: `${certificateState(ca, w)}, ${t('benutzt von {list}', { list: ca.usedBy.join(', ') })}`,
            })),
            { stacked: true }
          ) +
          mailText(
            t(
              'Was zu tun ist: eine hinterlegte Zertifizierungsstelle erneuert niemand von selbst. Holen Sie das neue Zertifikat der CA und ersetzen Sie die Datei unter Reverse-Proxy, Zertifikate, Reiter Zertifizierungsstellen. Nach dem Ablauf lehnt HAProxy die Ziele ab, die dagegen prüfen, und Besucher bekommen dort einen Fehler 503.'
            )
          ),
        action: { label: t('Zertifizierungsstellen ansehen'), path: '/reverse-proxy/zertifikate?bereich=zertifizierungsstellen' },
      };
    }

    case 'backend_down': {
      const name = targetName(event.kind, event.id, event.addresses, w);
      const id = strong(event.id);
      return {
        subject: t('{name}: kein Ziel antwortet', { name }),
        eyebrow: t('Reverse-Proxy'),
        heading: t('Kein Ziel antwortet'),
        body:
          mailText(
            event.kind === 'stream'
              ? t(
                  'Für die Weiterleitung {id} auf {node} antwortet kein Ziel mehr auf die Prüfung von HAProxy. Verbindungen über diese Weiterleitung kommen nicht zustande.',
                  { id, node }
                )
              : t(
                  'Für den Eintrag {id} auf {node} antwortet kein Ziel mehr auf die Prüfung von HAProxy. Anfragen an seine Domains bekommen eine Fehlerseite.',
                  { id, node }
                )
          ) +
          mailFacts([
            ...targetFacts(event.kind, event.id, event.addresses, w),
            ...(event.targets.length > 0 ? [{ label: t('Ziele'), value: event.targets.join(', ') }] : []),
            { label: t('Seit'), value: w.when(event.since) },
          ]) +
          mailText(
            t('Was zu tun ist: Prüfen, ob der Dienst auf dem Ziel läuft und von diesem Server aus erreichbar ist.') +
              (ctx.recoveryEnabled ? ` ${t('Sobald wieder ein Ziel antwortet, kommt eine zweite Mail.')}` : '')
          ),
        action: { label: t('Ziele ansehen'), path: '/reverse-proxy' },
      };
    }

    case 'backend_recovered': {
      const name = targetName(event.kind, event.id, event.addresses, w);
      const all = event.up === event.total;
      const downSince = event.downSince ? Date.parse(event.downSince) : Number.NaN;
      const id = strong(event.id);
      return {
        subject: all ? t('{name}: Ziele antworten wieder', { name }) : t('{name}: ein Teil der Ziele antwortet wieder', { name }),
        eyebrow: t('Reverse-Proxy'),
        heading: all ? t('Ziele antworten wieder') : t('Ein Teil der Ziele antwortet wieder'),
        body:
          mailText(
            event.kind === 'stream'
              ? t('Die Weiterleitung {id} auf {node} ist wieder erreichbar.', { id, node })
              : t('Der Eintrag {id} auf {node} ist wieder erreichbar.', { id, node })
          ) +
          mailFacts([
            ...targetFacts(event.kind, event.id, event.addresses, w),
            {
              label: t('Ziele, die antworten'),
              value: t('{up} von {total}', { up: event.up, total: event.total }),
              tone: all ? 'accent' : undefined,
            },
            ...(Number.isNaN(downSince)
              ? []
              : [
                  { label: t('Ausfall gemeldet'), value: w.when(event.downSince as string) },
                  { label: t('Dauer seit der Meldung'), value: w.duration(ctx.now.getTime() - downSince) },
                ]),
          ]) +
          (all ? '' : mailNote(t('Die übrigen Ziele antworten noch nicht.'), 'warning')),
        action: { label: t('Ziele ansehen'), path: '/reverse-proxy' },
      };
    }

    case 'haproxy_down':
      return {
        subject: t('HAProxy läuft nicht'),
        eyebrow: t('Reverse-Proxy'),
        heading: t('HAProxy läuft nicht'),
        body:
          mailText(
            t(
              'Der Container {container} auf {node} läuft nicht. Solange er nicht läuft, ist über diesen Server keine Domain und keine Weiterleitung erreichbar.',
              { container: code(event.container), node }
            )
          ) +
          mailFacts([
            {
              label: t('Zustand'),
              value: event.exists ? (event.status ?? t('unbekannt')) : t('Der Container existiert nicht'),
            },
            { label: t('Seit'), value: w.when(event.since) },
          ]) +
          mailText(
            event.exists
              ? t('Was zu tun ist: Auf dem Server zeigt {logs}, warum er beendet wurde. {start} startet ihn wieder.', {
                  logs: code(`docker logs ${event.container}`),
                  start: code(`docker start ${event.container}`),
                })
              : t('Was zu tun ist: Auf dem Server legt {command} im Ordner der Installation den Container wieder an.', {
                  command: code('docker compose up -d'),
                })
          ) +
          mailText(
            t('Läuft die Oberfläche von HAPM über HAProxy, ist sie so lange nur direkt über den Port von HAPM erreichbar.')
          ),
      };

    case 'run_failed': {
      const action = RUN_ACTION_LABELS[event.action] ? t(RUN_ACTION_LABELS[event.action]) : event.action;
      return {
        subject:
          event.action === 'settings'
            ? t('Vorgang gescheitert: {action}', { action })
            : t('Vorgang gescheitert: {action} ({entry})', { action, entry: event.entry }),
        eyebrow: t('Reverse-Proxy'),
        heading: t('Vorgang am Reverse-Proxy gescheitert'),
        body:
          mailText(t('Ein Vorgang am Reverse-Proxy auf {node} ist mit einem Fehler zu Ende gegangen.', { node })) +
          mailFacts([
            { label: t('Vorgang'), value: action },
            ...(event.action === 'settings' ? [] : [{ label: t('Name'), value: event.entry }]),
            ...(event.addresses ? [{ label: t('Adressen'), value: event.addresses }] : []),
            { label: t('Ausgelöst von'), value: triggeredByLabel(event.triggeredBy, w) },
            { label: t('Zeitpunkt'), value: w.when(ctx.now) },
          ]) +
          mailNote(machineHead(event.error, w), 'danger', t('Fehler')) +
          mailText(t('Was zu tun ist: Unter „Logs“ steht der Vorgang mit jedem Schritt und dessen Ergebnis.')),
        action: { label: t('Vorgänge ansehen'), path: '/reverse-proxy/logs' },
      };
    }

    case 'update_available': {
      const component = COMPONENT_LABELS[event.component];
      const newVersion = event.latestVersion && event.latestVersion !== event.currentVersion ? event.latestVersion : null;
      const automatic = ctx.autoUpdate
        ? ctx.autoUpdate.includes(event.component)
        : event.component === 'haproxy' && ctx.autoUpdateHaproxy;
      return {
        subject: newVersion
          ? t('Update verfügbar: {component} {version}', { component, version: newVersion })
          : t('Update verfügbar: neues Abbild für {component}', { component }),
        eyebrow: t('Updates'),
        heading: t('Update für {component} verfügbar', { component }),
        body:
          mailText(t('Für {component} auf {node} gibt es eine neue Fassung.', { component: strong(component), node })) +
          mailFacts([
            { label: t('Läuft'), value: event.currentVersion ?? t('Version unbekannt') },
            { label: t('Verfügbar'), value: newVersion ?? t('Neues Abbild derselben Fassung'), tone: 'accent' },
          ]) +
          mailText(
            automatic
              ? t('HAProxy wird um {time} Uhr selbsttätig aktualisiert. Unter „Updates“ geht es auch sofort.', {
                  time: escapeHtml(ctx.autoUpdateTime),
                })
              : t('Eingespielt wird es unter „Updates“. Von selbst geschieht nichts.')
          ),
        action: { label: t('Updates ansehen'), path: '/updates' },
      };
    }

    case 'update_completed': {
      const component = COMPONENT_LABELS[event.component];
      const changed = Boolean(event.toVersion && event.toVersion !== event.fromVersion);
      return {
        subject: changed
          ? t('{component} aktualisiert auf {version}', { component, version: event.toVersion ?? '' })
          : t('Update von {component} durchgelaufen', { component }),
        eyebrow: t('Updates'),
        heading: changed
          ? t('{component} aktualisiert', { component })
          : t('Update von {component} durchgelaufen', { component }),
        body:
          mailText(t('Das Update von {component} auf {node} ist ohne Fehler durchgelaufen.', { component: strong(component), node })) +
          mailFacts([
            { label: t('Vorher'), value: event.fromVersion ?? t('Version unbekannt') },
            { label: t('Jetzt'), value: event.toVersion ?? t('Version unbekannt'), tone: changed ? 'accent' : undefined },
            { label: t('Ausgelöst von'), value: triggeredByLabel(event.triggeredBy, w) },
            { label: t('Abgeschlossen'), value: w.when(ctx.now) },
          ]) +
          (changed
            ? ''
            : mailText(
                t(
                  'Die Versionsnummer ist dieselbe geblieben: Entweder lief schon das neueste Abbild, oder das neue trägt dieselbe Nummer. Die Schritte des Laufs stehen unter „Updates“.'
                )
              )),
        action: { label: t('Updates ansehen'), path: '/updates' },
      };
    }

    case 'update_failed': {
      const component = COMPONENT_LABELS[event.component];
      return {
        subject: t('Update von {component} gescheitert', { component }),
        eyebrow: t('Updates'),
        heading: t('Update von {component} gescheitert', { component }),
        body:
          mailText(t('Das Update von {component} auf {node} ist mit einem Fehler zu Ende gegangen.', { component: strong(component), node })) +
          mailFacts([
            { label: t('Fassung vor dem Update'), value: event.fromVersion ?? t('Version unbekannt') },
            { label: t('Ausgelöst von'), value: triggeredByLabel(event.triggeredBy, w) },
            { label: t('Zeitpunkt'), value: w.when(ctx.now) },
          ]) +
          mailNote(machineHead(event.error, w), 'danger', t('Fehler')) +
          mailText(t('Was zu tun ist: Unter „Updates“ steht der Lauf in der Historie, mit jedem Schritt und dessen Ausgabe.')),
        action: { label: t('Updates ansehen'), path: '/updates' },
      };
    }

    case 'crowdsec_down': {
      const scope = event.global
        ? t('alle Ziele')
        : w.plural(event.protectedServices, { one: '{count} Ziel', other: '{count} Ziele' });
      const subject = event.role === 'bouncer' ? t('Der Bouncer von CrowdSec läuft nicht') : t('CrowdSec läuft nicht');
      return {
        subject,
        eyebrow: 'CrowdSec',
        heading: subject,
        body:
          mailText(t('Der Container {container} auf {node} läuft nicht.', { container: code(event.container), node })) +
          mailNote(
            event.role === 'bouncer'
              ? t('HAProxy erreicht den Bouncer nicht und lässt jede Anfrage ungeprüft durch, damit die Ziele erreichbar bleiben. Weder WAF noch Sperren wirken.')
              : t('Die WAF prüft keine Anfrage, und aus dem Log von HAProxy entstehen keine neuen Sperren. Die Ziele bleiben erreichbar.'),
            'warning'
          ) +
          mailFacts([
            {
              label: t('Zustand'),
              value: event.exists ? (event.status ?? t('unbekannt')) : t('Der Container existiert nicht'),
            },
            { label: t('Seit'), value: w.when(event.since) },
            { label: t('Geschützt'), value: scope },
          ]) +
          mailText(
            event.exists
              ? t('Was zu tun ist: Auf dem Server zeigt {logs}, warum er beendet wurde. {start} startet ihn wieder.', {
                  logs: code(`docker logs ${event.container}`),
                  start: code(`docker start ${event.container}`),
                })
              : t('Was zu tun ist: Auf dem Server legt {command} im Ordner der Installation den Container wieder an.', {
                  command: code('docker compose up -d'),
                })
          ),
        action: { label: t('CrowdSec ansehen'), path: '/reverse-proxy/crowdsec' },
      };
    }

    case 'crowdsec_report': {
      const { totals } = event;
      const rows = (list: { key: string; count: number }[]) =>
        list.slice(0, 5).map((row) => ({ label: row.key, value: formatCount(w.locale, row.count) }));
      return {
        subject: w.plural(totals.alerts, {
          one: 'CrowdSec: {count} Ereignis in 24 Stunden',
          other: 'CrowdSec: {count} Ereignisse in 24 Stunden',
        }),
        eyebrow: 'CrowdSec',
        heading: t('Was CrowdSec erkannt hat'),
        body:
          mailText(
            t('Zwischen {from} und {to} hat CrowdSec auf {node} {count} gemeldet.', {
              from: w.when(event.from),
              to: w.when(event.to),
              node,
              count: strong(w.plural(totals.alerts, { one: '{count} Ereignis', other: '{count} Ereignisse' })),
            })
          ) +
          mailFacts([
            { label: t('WAF-Treffer'), value: formatCount(w.locale, totals.waf) },
            { label: t('Erkannt im Log'), value: formatCount(w.locale, totals.scenario) },
            { label: t('Von Hand gesperrt'), value: formatCount(w.locale, totals.manual) },
            { label: t('Verschiedene Adressen'), value: formatCount(w.locale, totals.sources) },
            {
              label: t('Jetzt aktive Sperren'),
              value: event.activeDecisions === null ? t('unbekannt') : formatCount(w.locale, event.activeDecisions),
            },
          ]) +
          mailFacts(rows(event.scenarios), { title: t('Häufigste Regeln') }) +
          mailFacts(rows(event.sources), { title: t('Häufigste Adressen') }) +
          mailFacts(rows(event.targets), { title: t('Betroffene Ziele') }) +
          mailText(
            t('Was zu tun ist: Nichts, solange die Treffer von außen kommen. Steht eine eigene Adresse oder die eines Nutzers darunter, gehört sie unter CrowdSec in die Freigaben.')
          ),
        action: { label: t('Ereignisse ansehen'), path: '/reverse-proxy/crowdsec?bereich=ereignisse' },
      };
    }

    case 'backup_failed':
      return {
        subject: t('Sicherung gescheitert'),
        eyebrow: t('Sicherung'),
        heading: t('Sicherung gescheitert'),
        body:
          mailText(t('Die Sicherung von HAPM auf {node} ist am {when} gescheitert.', { node, when: w.when(ctx.now) })) +
          mailNote(machineHead(event.detail, w), 'danger', t('Fehler')) +
          mailText(t('Was zu tun ist: Unter „Sicherung“ steht, was eingestellt ist und wie der letzte Lauf ausging.')),
        action: { label: t('Sicherung ansehen'), path: '/backup' },
      };

    case 'audit_forward_failed':
      return {
        subject: t('Weiterleitung des Protokolls gescheitert'),
        eyebrow: t('Protokoll'),
        heading: t('Weiterleitung des Protokolls gescheitert'),
        body:
          mailText(
            t('HAPM auf {node} kann das Protokoll nicht an {target} weiterleiten. Die Einträge bleiben in HAPM und gehen hinaus, sobald der Empfänger wieder annimmt.', {
              node,
              target: code(event.target),
            })
          ) +
          mailFacts([
            { label: t('Art'), value: event.destination === 'syslog' ? 'Syslog' : t('HTTP-Endpunkt') },
            { label: t('Seit'), value: w.when(event.since) },
          ]) +
          mailNote(machineHead(event.error, w), 'danger', t('Fehler')) +
          mailText(t('Was zu tun ist: Unter „Protokoll“, Reiter „Weiterleitung an SIEM“, stehen Rückstand und der letzte Fehler. Eine Testnachricht zeigt, ob der Empfänger wieder antwortet.')),
        action: { label: t('Protokoll ansehen'), path: '/protokoll?bereich=weiterleitung' },
      };
  }
}

export function notificationMail(event: NotificationEvent, ctx: NotificationMailContext): NotificationMail {
  const w = writer(ctx);
  const content = draft(event, ctx, w);
  const action: MailAction | undefined =
    content.action && ctx.publicUrl ? { label: content.action.label, url: `${ctx.publicUrl}${content.action.path}` } : undefined;

  const rendered = renderHapmMail(
    {
      subject: content.subject,
      eyebrow: content.eyebrow,
      heading: content.heading,
      body: content.body,
      action,
      footerNote: w.t(NOTIFICATION_FOOTER_NOTE),
    },
    { nodeName: ctx.nodeName, publicUrl: ctx.publicUrl, locale: w.locale }
  );
  return { subject: content.subject, ...rendered };
}

/** Die Testmail von der Seite „Benachrichtigungen". */
export function testMail(installation: MailInstallation): NotificationMail {
  const { t } = createTranslator(installation.locale);
  const subject = t('Testmail von HAPM');
  const rendered = renderHapmMail(
    {
      subject,
      eyebrow: t('Benachrichtigungen'),
      heading: t('Der Versand funktioniert'),
      body:
        mailText(
          t(
            'Diese Mail hat HAPM auf {node} über das eingerichtete SMTP-Konto verschickt. Kommt sie an, stimmen Server, Anmeldung und Absender.',
            { node: strong(installation.nodeName) }
          )
        ) + mailText(t('Wer sie bekommt und zu welchen Ereignissen, steht unter „Benachrichtigungen“.')),
      action: installation.publicUrl
        ? { label: t('Benachrichtigungen öffnen'), url: `${installation.publicUrl}/notifications` }
        : undefined,
    },
    installation
  );
  return { subject, ...rendered };
}
