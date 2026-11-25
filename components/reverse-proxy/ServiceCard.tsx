'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  Globe, Activity, GitBranch, Server, Lock, LockOpen, Pencil, Trash2, Loader2, ArrowRight,
  EyeOff, ChevronDown, ChevronRight, CornerUpRight, Scale, Cookie, BarChart3, KeyRound, ShieldCheck,
  SlidersHorizontal, LockKeyhole, Hourglass,
} from 'lucide-react';
import {
  BALANCE_LABELS,
  BALANCE_HINTS,
  shortTarget,
  type BackendTls,
  type HaproxyService,
  type ServiceHealth,
} from '@/lib/haproxy/config';
import { msgid } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';
import type { ProxyRow } from './types';
import { findSavedTarget, type SavedTarget } from '@/lib/haproxy/saved-targets';

/**
 * Ein Reverse-Proxy-Ziel als Karte.
 *
 * Eigene Komponente und nicht `EntityCard`, und das ist eine bewusste Ausnahme:
 * die Karte trägt keine Liste aus Beschriftung und Wert, sondern gegliederte
 * Abschnitte — die Ziele des Standard-Backends und, aufklappbar, die
 * Pfad-Regeln. Eine Ausnahme bleibt es trotzdem: sie liegt in EINER Datei,
 * nicht in acht (siehe die Warnung zu den Karten in CLAUDE.md).
 *
 * ── Zwei Regeln gegen wachsende Karten ──
 *
 * **Die Marken bleiben in einer Zeile.** Ein Eintrag kann Healthcheck, Zusätze,
 * Sperre, drei Alias-Domains und einen Maschinennamen tragen; als Wortwolke
 * gesetzt war die Kopfzeile höher als der Inhalt darunter, und die Karten einer
 * Reihe standen auf verschiedenen Höhen. Zwei stehen da, der Rest steht als
 * Anzahl daneben und im Tooltip.
 *
 * **Die Routen sind zugeklappt.** Sie sind der Grund, warum EIN Eintrag doppelt
 * so hoch war wie seine Nachbarn — und sie beantworten eine Frage, die man
 * gezielt stellt, nicht die Frage „was steht hier".
 */

interface Props {
  proxy: ProxyRow;
  service: HaproxyService;
  /** Die hinterlegten Backend-Server: steht eine Adresse darunter, nennt die Karte ihren Namen. */
  savedTargets?: SavedTarget[];
  /** Während die Sperre umgelegt wird. */
  busy: boolean;
  /** Der Eintrag wird gerade geschrieben: Zertifikat, Prüfung, Reload. Bis das
   *  durch ist, steht auf der Karte noch der ALTE Stand — deshalb sagt sie das
   *  auch, statt so zu tun, als sei die Änderung schon drin. */
  pendingPhase?: string | null;
  /**
   * Was gerade mit dem Eintrag passiert.
   *
   * Beide sehen aus wie sonst, nur mit Spinner statt Globus: die Karte färbte
   * sich einmal gelb beim Schreiben und rot beim Entfernen, und beides las sich
   * als Warnung, wo bloß etwas läuft. Der Unterschied steht im Text der Marke —
   * „Wird entfernt" neben der Phase — und nicht in der Fläche dahinter.
   */
  pendingKind?: 'write' | 'delete';
  /** Was HAProxys eigener Healthcheck über die Ziele sagt. `unknown` heißt: es
   *  wurde nicht geprüft — und das ist nicht dasselbe wie „in Ordnung". */
  health: ServiceHealth;
  onToggleLock: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

/**
 * Ein Eintrag, den es noch gar nicht gibt: das Anlegen läuft.
 *
 * Er taucht auf, sobald der Vorgang gestartet ist, und nicht erst, wenn er
 * durch ist. Vorher blieb die Liste nach dem Klick auf „Anlegen" minutenlang
 * unverändert — die Domain war unterwegs, und die Seite sah aus, als wäre der
 * Klick verlorengegangen.
 *
 * Bewusst KEIN halb gefülltes `HaproxyService`: was auf der Maschine steht,
 * weiß hier niemand, und eine Karte mit erfundenen Backend-Zeilen wäre eine
 * Behauptung über eine Konfiguration, die es noch nicht gibt.
 *
 * Die Schritte stehen nicht auf der Karte, nur die Phase als Marke: der Ablauf
 * steht im Fenster des Laufs (`components/runs/RunOverlay.tsx`).
 */
export function PendingCard({
  title,
  phase,
  queued = false,
}: {
  title: string;
  phase: string | null;
  /** Der Lauf steht am Lock hinter einem anderen und hat noch nicht begonnen. */
  queued?: boolean;
}) {
  const { t } = useT();
  return (
    <div className="rp-card">
      <div className="rp-card-head">
        <span className="rp-card-icon">
          <Loader2 size={20} className="spin" />
        </span>
        <div className="rp-card-heading">
          <span className="rp-card-title">{title}</span>
        </div>
      </div>
      <div className="rp-tags">
        <span className="rp-tag is-pending">
          {queued ? <Hourglass size={14} /> : <Loader2 size={14} className="spin" />}
          {phase ? t(phase) : t('Wird eingerichtet')}
        </span>
      </div>
      <div className="rp-section">
        <div className="rp-empty-line">
          {queued
            ? t('Ein anderer Vorgang an HAProxy läuft noch. Dieser beginnt, sobald er fertig ist.')
            : t('Zertifikat, Prüfung und Reload laufen. Der Eintrag erscheint vollständig, sobald HAProxy die neue Konfiguration übernommen hat.')}
        </div>
      </div>
    </div>
  );
}

interface Tag {
  key: string;
  icon: ReactNode;
  label: string;
  tooltip?: string;
  className?: string;
}

/** Wie viele Marken nebeneinander passen, ohne dass die Zeile umbricht. */
const MAX_TAGS = 2;

/** Was das Schloss an einer Zeile heißt, im Tooltip. */
const TLS_TOOLTIPS: Record<Exclude<BackendTls, 'off'>, string> = {
  insecure: msgid('HAProxy spricht HTTPS mit dem Ziel, ohne das Zertifikat zu prüfen'),
  verify: msgid('HAProxy spricht HTTPS mit dem Ziel und prüft das Zertifikat'),
};

/**
 * Der Zustand steckt in der Healthcheck-Marke, nicht in einem eigenen Zeichen.
 *
 * Hier saß ein Punkt am Symbol. Er war klein, hatte keine Beschriftung und
 * stand neben einer Marke, auf der „Healthcheck" steht — zwei Zeichen für
 * dieselbe Sache, und das kleinere trug die Aussage. Jetzt sagt die Marke
 * selbst, was der Check ergeben hat: grün erreichbar, rot nicht.
 *
 * Die Klassennamen stehen ausgeschrieben, weil `tests/ui/css-classes.test.ts`
 * sie aus dem Quelltext liest — aus `is-${health}` würde dort das Fragment
 * `.is-`, das in keiner CSS-Datei steht.
 */
const HEALTH_TAG: Record<ServiceHealth, { className: string; tooltip: string }> = {
  up: {
    className: 'is-online',
    tooltip: msgid('HAProxy erreicht alle Ziele dieses Eintrags'),
  },
  partial: {
    className: 'is-degraded',
    tooltip: msgid('HAProxy erreicht einen Teil der Ziele nicht'),
  },
  down: {
    className: 'is-offline',
    tooltip: msgid('HAProxy erreicht kein Ziel dieses Eintrags'),
  },
  // Nicht grün: „nicht geprüft" ist nicht „in Ordnung". Der Tooltip sagt, woran
  // es liegt, statt die Marke wegzulassen — dass geprüft WERDEN soll, steht ja
  // in der Konfiguration.
  unknown: {
    className: '',
    tooltip: msgid(
      'HAProxy prüft die Ziele. Ihr Zustand ist hier nicht bekannt: kein stats socket in der Konfiguration, kein socat oder kein check auf der server-Zeile.'
    ),
  },
};

export default function ServiceCard({
  proxy,
  service,
  savedTargets = [],
  busy,
  pendingPhase,
  pendingKind = 'write',
  health,
  onToggleLock,
  onEdit,
  onDelete,
}: Props) {
  const { t } = useT();
  const [routesOpen, setRoutesOpen] = useState(false);
  /**
   * Ab dem Klick, nicht erst ab der Antwort.
   *
   * `busy` ist die halbe Sekunde, in der die Route den Lauf anlegt, `pendingPhase`
   * die Minuten danach. Nur auf das Zweite zu reagieren hieße: man drückt das
   * Schloss, und für einen Moment passiert sichtbar nichts — genau der Moment,
   * in dem man ein zweites Mal drückt.
   */
  const pending = busy || (pendingPhase !== undefined && pendingPhase !== null);
  const removing = pending && pendingKind === 'delete';
  const phaseLabel = pendingPhase ? t(pendingPhase) : t('Wird gestartet');

  const readOnlyReason =
    service.extras.length > 0
      ? t('Nicht abgebildet: {extras}', { extras: service.extras.join(' · ') })
      : t('ACL, Weiche oder Backend folgen nicht dem erwarteten Schema');

  /* Drei Zustände, zwei Handlungen: offen, teilweise gesperrt, ganz gesperrt —
   * der Knopf sperrt alles oder öffnet alles. Wer einzelne Domains meint,
   * macht das im Dialog, wo die Domains stehen.
   *
   * WIE gesperrt ist (Admin-IPs oder Passwort), ändert an den drei Zuständen
   * nichts, nur an den Wörtern. Beim Sperren fragt die Seite danach
   * (`LockDialog`), beim Lösen nicht. */
  /* Über dieses Ziel läuft die Adresse von HAPM (`lib/haproxy/protected.ts`).
   * Die Route lehnt das Entfernen ab. Die Karte sagt es vorher, statt einen
   * Knopf anzubieten, der dann scheitert. */
  const surface = proxy.surface?.serviceId === service.id ? proxy.surface : null;

  /** Die Zusätze in Worten, für die Marke: feste Header und das lange Timeout. */
  const addons = [
    ...service.responseHeaders.map((rule) => t('Antwort: {name}', { name: rule.name })),
    ...service.requestHeaders.map((rule) => t('Anfrage: {name}', { name: rule.name })),
    ...(service.tunnel ? [t('Lange Verbindungen')] : []),
  ];

  const lockedCount = service.lockedDomains.length;
  const fullyLocked = lockedCount > 0 && lockedCount === service.domains.length;
  const partlyLocked = lockedCount > 0 && !fullyLocked;
  const byPassword = service.passwordLock !== null;
  const addresses = proxy.adminIps.join(', ');
  const lockedDomains = service.lockedDomains.join(', ');

  const lockTooltip = !service.editable
    ? t('Nicht änderbar. {reason}.', { reason: readOnlyReason })
    : partlyLocked
      ? byPassword
        ? t('Gesperrt mit Passwort: {domains}. Hier alle Domains öffnen.', { domains: lockedDomains })
        : t('Gesperrt auf {addresses}: {domains}. Hier alle Domains öffnen.', { addresses, domains: lockedDomains })
      : fullyLocked
        ? byPassword
          ? t('Gesperrt mit Passwort. Hier lösen.')
          : t('Gesperrt auf {addresses}. Hier lösen.', { addresses })
        : t('Offen für alle. Hier sperren: auf Admin-IPs oder mit Passwort.');

  /* Nach Wichtigkeit, denn abgeschnitten wird von hinten: eine Sperre und ein
   * „nur lesbar" ändern, was man mit dem Eintrag tun kann; eine Alias-Domain
   * steht ohnehin im Dialog. Die Anzahl der Routen fehlt hier bewusst — sie
   * steht als Überschrift über den Routen selbst. */
  const tags: Tag[] = [
    // Ganz vorn, damit sie nie im „+1" verschwindet: sie erklärt den gesperrten
    // Löschen-Knopf. Ein Schild und kein Schloss, das hier schon die Sperre meint.
    ...(surface
      ? [{
          key: 'surface',
          icon: <ShieldCheck size={14} />,
          label: t('Oberfläche von HAPM'),
          tooltip: t('HAPM ist über dieses Ziel erreichbar ({url}). Es lässt sich nicht entfernen.', { url: surface.url }),
          className: 'is-muted',
        }]
      : []),
    ...(lockedCount > 0
      ? [{
          key: 'locked',
          icon: byPassword ? <KeyRound size={14} /> : <Lock size={14} />,
          label: fullyLocked
            ? t(byPassword ? 'Passwort' : 'Nur Admin-IPs')
            : t('{locked} von {total} gesperrt', { locked: lockedCount, total: service.domains.length }),
          tooltip: byPassword
            ? fullyLocked
              ? t('Besucher sehen eine Passwortabfrage')
              : t('Passwortabfrage für: {domains}', { domains: lockedDomains })
            : fullyLocked
              ? t('Nur erreichbar von {addresses}', { addresses })
              : t('Nur von {addresses} erreichbar: {domains}', { addresses, domains: lockedDomains }),
          className: fullyLocked ? 'is-locked' : 'is-partly-locked',
        }]
      : []),
    /* Verdeckt heißt: HAProxy erreicht diese Weiche nie, weil eine Wildcard
     * weiter oben schon passt. Der Eintrag steht in der Datei, hat ein
     * Zertifikat und antwortet trotzdem nicht — und `haproxy -c` findet daran
     * nichts. Über das Werkzeug angelegt kann das nicht passieren
     * (`insertServiceBlock` sortiert), von Hand geschrieben schon. */
    ...(service.shadowedBy
      ? [{
          key: 'shadowed',
          icon: <EyeOff size={14} />,
          label: t('Verdeckt'),
          tooltip: t(
            'Die Weiche von „{other}" steht weiter oben und passt auch für diese Domains. HAProxy nimmt die erste, dieser Eintrag wird nie erreicht.',
            { other: service.shadowedBy }
          ),
          className: 'is-offline',
        }]
      : []),
    ...(service.editable
      ? []
      : [{
          key: 'readonly',
          icon: <EyeOff size={14} />,
          label: t('Nur lesbar'),
          tooltip: readOnlyReason,
          className: 'is-muted',
        }]),
    /* Die Healthcheck-Marke trägt den Zustand: grün erreichbar, rot nicht,
     * gelb teilweise. Sie steht auch dann da, wenn der Zustand unbekannt ist —
     * dass geprüft wird, ist eine Eigenschaft des Eintrags, und der Tooltip
     * sagt, warum nichts dazu bekannt ist. Umgekehrt steht sie ohne
     * eingeschalteten Check trotzdem da, wenn HAProxy etwas über die Ziele
     * meldet: dann prüft es sie aus einer Zeile, die nicht aus diesem Formular
     * stammt. */
    ...(service.healthcheck || health !== 'unknown'
      ? [{
          key: 'healthcheck',
          icon: <Activity size={14} />,
          label: 'Healthcheck',
          tooltip: t(HEALTH_TAG[health].tooltip),
          className: HEALTH_TAG[health].className,
        }]
      : []),
    /* Was den Eintrag zur Lastverteilung macht. Vor den Zusätzen, weil es die
     * Frage beantwortet, wonach die Karte aussieht: bei zwei Zielen will man
     * wissen, wie verteilt wird — und ob ein Besucher bei seinem Ziel bleibt.
     * Beide Marken stehen nur da, wenn die Zeile wirklich in der Datei steht:
     * ohne `balance` gilt der defaults-Block, und was dort steht, weiß diese
     * Karte nicht. */
    ...(service.balance
      ? [{
          key: 'balance',
          icon: <Scale size={14} />,
          label: t(BALANCE_LABELS[service.balance]),
          tooltip: t(BALANCE_HINTS[service.balance]),
        }]
      : []),
    ...(service.sticky
      ? [{
          key: 'sticky',
          icon: <Cookie size={14} />,
          label: t('Sitzungsbindung'),
          tooltip: t(
            'Ein Besucher bleibt über einen Cookie bei dem Ziel, auf dem er gelandet ist. HAProxy setzt ihn selbst und nimmt ihn aus der Anfrage, bevor sie hinten ankommt.'
          ),
        }]
      : []),
    /* Hinter dem Healthcheck: die Zusätze sind eine Eigenschaft, die sich nicht
     * ändert, und sie stehen im Dialog. Der Healthcheck sagt, ob der Eintrag
     * GERADE trägt. EINE Marke für alle, die Zeilen selbst stehen im Tooltip. */
    ...(addons.length > 0
      ? [{
          key: 'addons',
          icon: <SlidersHorizontal size={14} />,
          label: t(addons.length === 1 && service.tunnel ? 'Lange Verbindungen' : 'Header'),
          tooltip: addons.join(' · '),
          className: 'is-muted',
        }]
      : []),
    // Der Tooltip trägt die Domain selbst und nicht ihre Beschreibung: sie ist
    // das, was in der Marke abgeschnitten wird.
    ...service.domains.slice(1).map((domain) => ({
      key: `domain-${domain}`,
      icon: <Globe size={14} />,
      label: domain,
      tooltip: t('Weitere Domain: {domain}', { domain }),
      className: 'is-muted',
    })),
  ];
  const visible = tags.slice(0, MAX_TAGS);
  const hidden = tags.slice(MAX_TAGS);

  /* Auch beim Entfernen bleibt die Karte, wie sie ist. Sie war einmal rot
     hinterlegt, und das passte zu nichts: der Spinner im Symbol, die Marken und
     die Knöpfe darin behielten ihre eigenen Farben, und die Fläche sah aus, als
     stimme etwas nicht, statt dass etwas läuft. Was gerade geschieht, sagt die
     Marke — dieselbe Regel wie beim Schreiben. */
  return (
    <div className="rp-card">
      <div className="rp-card-head">
        <span className="rp-card-icon">
          {pending ? <Loader2 size={20} className="spin" /> : <Globe size={20} />}
        </span>
        {/* Der Tooltip sitzt am Rahmen und nicht am Text: Titel und Unterzeile
            kürzen selbst, und ein Element mit `overflow: hidden` schneidet
            seinen eigenen Tooltip weg. */}
        <div
          className="rp-card-heading"
          data-tooltip={t('{domains} · Dienst-ID {id}', { domains: service.domains.join(', ') || service.id, id: service.id })}
        >
          {/* Nur die Domain. Die Dienst-ID stand darunter und sagte beim
              Überfliegen nichts, sie steht im Tooltip. */}
          <span className="rp-card-title">{service.domains[0] ?? service.id}</span>
        </div>
      </div>

      {pending && (
        <div className="rp-tags">
          <span
            className="rp-tag is-pending"
            data-tooltip={t('Der Vorgang läuft. Der Fortschritt steht unten rechts.')}
          >
            <Loader2 size={14} className="spin" />
            <span className="rp-tag-label">
              {removing ? t('Wird entfernt · {phase}', { phase: phaseLabel }) : phaseLabel}
            </span>
          </span>
        </div>
      )}

      {!pending && tags.length > 0 && (
        <div className="rp-tags">
          {visible.map((tag) => (
            <span
              key={tag.key}
              className={`rp-tag ${tag.className ?? ''}`}
              data-tooltip={tag.tooltip}
            >
              {tag.icon}
              <span className="rp-tag-label">{tag.label}</span>
            </span>
          ))}
          {hidden.length > 0 && (
            <span
              className="rp-tag is-muted is-count"
              data-tooltip={hidden.map((tag) => tag.label).join(' · ')}
            >
              +{hidden.length}
            </span>
          )}
        </div>
      )}

      {service.redirect ? (
        /* Eine Weiterleitung hat kein Backend, also auch keine Zeile mit Name
           und Adresse. Was hier steht, ist die eine Auskunft, die es gibt:
           wohin, und ob der Pfad mitgeht. */
        <div className="rp-section">
          <div
            className="rp-section-title"
            data-tooltip={t('Die Domains werden nicht bedient, sondern weitergeschickt')}
          >
            <CornerUpRight size={16} />
            {t('Weiterleitung')}
            <span className="rp-section-count">
              {service.redirect.permanent ? '301' : '302'}
            </span>
          </div>
          <div
            className="rp-row"
            data-tooltip={
              service.redirect.keepPath
                ? t('Pfad geht mit: /pfad → {to}/pfad', { to: service.redirect.to })
                : t('Alles geht auf {to}', { to: service.redirect.to })
            }
          >
            <span className="rp-row-icon">
              <ArrowRight size={14} />
            </span>
            <span className="rp-row-name">{service.redirect.to}</span>
            <span className="rp-chip">
              {t(service.redirect.keepPath ? 'mit Pfad' : 'ohne Pfad')}
            </span>
          </div>
        </div>
      ) : (
      <div className="rp-section">
        <div
          className="rp-section-title"
          data-tooltip={t('Wohin alles geht, was auf keine Pfad-Regel passt')}
        >
          <Server size={16} />
          {t('Backend')}
        </div>
        {service.servers.length === 0 ? (
          <div className="rp-empty-line">{t('kein Backend-Server eingetragen')}</div>
        ) : (
          service.servers.map((server) => {
            // Der Name der server-Zeile (`server1`) sagt nichts, er entsteht
            // beim Schreiben. Was zählt, ist die Adresse, und wenn sie als
            // Backend-Server hinterlegt ist, dessen Name.
            const saved = findSavedTarget(server.target, savedTargets);
            const address = saved ? `${saved.name} · ${server.target}` : server.target;
            return (
              <div
                className="rp-row"
                key={server.name}
                data-tooltip={server.tls === 'off' ? address : `${address} · ${t(TLS_TOOLTIPS[server.tls])}`}
              >
                <span className="rp-row-icon">
                  <Server size={14} />
                </span>
                <span className="rp-row-name rp-row-address">{server.target}</span>
                {saved && <span className="rp-chip">{saved.name}</span>}
                {/* HAProxy spricht HTTPS mit dem Ziel. Ein anderes Schloss als
                    das der Sperre: das hier sagt nichts darüber, wer
                    hereinkommt. */}
                {server.tls !== 'off' && (
                  <span className="rp-chip">
                    <LockKeyhole size={12} />
                    {t('HTTPS')}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>
      )}

      {service.routes.length > 0 && (
        <div className="rp-section">
          <button
            type="button"
            className="rp-section-title rp-section-toggle"
            onClick={() => setRoutesOpen((open) => !open)}
            aria-expanded={routesOpen}
            data-tooltip={
              routesOpen
                ? t('Pfad-Regeln zuklappen')
                : t('Pfade, die auf einen anderen Port gehen: {paths}', {
                    paths: service.routes.map((r) => r.paths.join(' ')).join(', '),
                  })
            }
          >
            {routesOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <GitBranch size={16} />
            {t('Routen')}
            <span className="rp-section-count">{service.routes.length}</span>
          </button>
          {routesOpen &&
            service.routes.map((route) => (
              /* Der Tooltip nennt die VOLLE Adresse: der Chip zeigt nur den
                 Port, solange das Ziel auf derselben Maschine liegt. */
              <div
                className="rp-row rp-route"
                key={route.name}
                data-tooltip={`${route.paths.join(' ')} → ${route.servers.map((s) => s.target).join(', ')}${
                  route.backendTls === 'off' ? '' : ` · ${t(TLS_TOOLTIPS[route.backendTls])}`
                }`}
              >
                <span className="rp-chip is-accent">{route.paths.join(' ')}</span>
                <span className="rp-route-line" />
                <span className="rp-route-arrow">
                  <ArrowRight size={14} />
                </span>
                {/* Nur der Port, solange das Ziel auf derselben Maschine liegt
                    wie das Standard-Backend. Eine andere Adresse steht voll da,
                    sonst behauptete die Karte eine Maschine, die es nicht ist. */}
                <span className="rp-chip is-accent">
                  {route.backendTls !== 'off' && <LockKeyhole size={12} />}
                  {route.servers
                    .map((s) => shortTarget(s.target, service.servers[0]?.target))
                    .join(', ')}
                </span>
              </div>
            ))}
        </div>
      )}

      <div className="rp-actions">
        <button
          type="button"
          className={`rp-action${
            fullyLocked ? ' is-locked' : partlyLocked ? ' is-partly-locked' : ' is-open'
          }`}
          data-tooltip={lockTooltip}
          disabled={!service.editable || busy || pending}
          onClick={onToggleLock}
          aria-label={t(lockedCount > 0 ? 'Alle Domains öffnen' : 'Sperren')}
        >
          {busy ? (
            <Loader2 size={16} className="spin" />
          ) : lockedCount > 0 ? (
            <Lock size={16} />
          ) : (
            <LockOpen size={16} />
          )}
        </button>
        <button
          type="button"
          className="rp-action"
          data-tooltip={service.editable ? t('Bearbeiten') : t('Nicht änderbar. {reason}.', { reason: readOnlyReason })}
          disabled={!service.editable || pending}
          onClick={onEdit}
          aria-label={t('Bearbeiten')}
        >
          <Pencil size={16} />
        </button>
        {/*
          Ein Link und kein Knopf mit `router.push`: das Ziel ist eine Adresse,
          also soll sie sich auch in einem neuen Tab öffnen lassen — beim
          Vergleichen zweier Dienste ist genau das der Weg. `?dienst=` ist
          derselbe Parameter, mit dem die Zertifikatsseite auf einen Eintrag
          zeigt, und die Statistik-Seite löst ihn genauso auf.

          Er steht NICHT unter der Bedingung `editable`: eine Auswertung ist
          lesend, und gerade der Eintrag, den dieses Werkzeug nicht anfassen
          darf, ist einer, über den man etwas wissen will.
        */}
        <Link
          href={`/reverse-proxy/statistiken?dienst=${encodeURIComponent(service.id)}`}
          className="rp-action"
          data-tooltip={t('Statistik dieses Dienstes')}
          aria-label={t('Statistik')}
        >
          <BarChart3 size={16} />
        </Link>
        <button
          type="button"
          className="rp-action is-danger"
          data-tooltip={
            surface
              ? t('Nicht entfernbar: Oberfläche von HAPM. Die Adresse steht unter Allgemein.')
              : service.removable
                ? t('Löschen')
                : t('Nicht über HAPM angelegt: ACL, Weiche oder Backend folgen nicht dem erwarteten Schema')
          }
          disabled={!service.removable || surface !== null || pending}
          onClick={onDelete}
          aria-label={t('Löschen')}
        >
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}
