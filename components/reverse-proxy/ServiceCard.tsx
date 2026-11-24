'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  Globe, Activity, GitBranch, Box, Server, Lock, LockOpen, Pencil, Trash2, Loader2, ArrowRight,
  EyeOff, ChevronDown, ChevronRight, CornerUpRight, Scale, Cookie, BarChart3, KeyRound, ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react';
import {
  BALANCE_LABELS,
  BALANCE_HINTS,
  shortTarget,
  type HaproxyService,
  type ServiceHealth,
} from '@/lib/haproxy/config';
import type { ProxyRow } from './types';

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
 */
export function PendingCard({
  title,
  subtitle,
  phase,
}: {
  title: string;
  subtitle: string;
  phase: string | null;
}) {
  return (
    <div className="rp-card">
      <div className="rp-card-head">
        <span className="rp-card-icon">
          <Loader2 size={20} className="spin" />
        </span>
        <div className="rp-card-heading">
          <span className="rp-card-title">{title}</span>
          <span className="rp-card-subtitle">{subtitle}</span>
        </div>
      </div>
      <div className="rp-tags">
        <span className="rp-tag is-pending">
          <Loader2 size={14} className="spin" />
          {phase ?? 'Wird eingerichtet'}
        </span>
      </div>
      <div className="rp-section">
        <div className="rp-empty-line">
          Zertifikat, Prüfung und Reload laufen. Der Eintrag erscheint vollständig, sobald HAProxy
          die neue Konfiguration übernommen hat.
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
    tooltip: 'HAProxy erreicht alle Ziele dieses Eintrags',
  },
  partial: {
    className: 'is-degraded',
    tooltip: 'HAProxy erreicht einen Teil der Ziele nicht',
  },
  down: {
    className: 'is-offline',
    tooltip: 'HAProxy erreicht kein Ziel dieses Eintrags',
  },
  // Nicht grün: „nicht geprüft" ist nicht „in Ordnung". Der Tooltip sagt, woran
  // es liegt, statt die Marke wegzulassen — dass geprüft WERDEN soll, steht ja
  // in der Konfiguration.
  unknown: {
    className: '',
    tooltip:
      'HAProxy prüft die Ziele. Ihr Zustand ist hier nicht bekannt: kein stats socket in der Konfiguration, kein socat oder kein check auf der server-Zeile.',
  },
};

export default function ServiceCard({
  proxy,
  service,
  busy,
  pendingPhase,
  pendingKind = 'write',
  health,
  onToggleLock,
  onEdit,
  onDelete,
}: Props) {
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
  const phaseLabel = pendingPhase ?? 'Wird gestartet';

  const readOnlyReason =
    service.extras.length > 0
      ? `Nicht abgebildet: ${service.extras.join(' · ')}`
      : 'ACL, Weiche oder Backend folgen nicht dem erwarteten Schema';

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
    ...service.responseHeaders.map((rule) => `Antwort: ${rule.name}`),
    ...service.requestHeaders.map((rule) => `Anfrage: ${rule.name}`),
    ...(service.tunnel ? ['Lange Verbindungen'] : []),
  ];

  const lockedCount = service.lockedDomains.length;
  const fullyLocked = lockedCount > 0 && lockedCount === service.domains.length;
  const partlyLocked = lockedCount > 0 && !fullyLocked;
  const byPassword = service.passwordLock !== null;
  const lockedHow = byPassword ? 'mit Passwort' : `auf ${proxy.adminIps.join(', ')}`;

  const lockTooltip = !service.editable
    ? `Nicht änderbar. ${readOnlyReason}.`
    : partlyLocked
      ? `Gesperrt ${lockedHow}: ${service.lockedDomains.join(', ')}. Hier alle Domains öffnen.`
      : fullyLocked
        ? `Gesperrt ${lockedHow}. Hier lösen.`
        : 'Offen für alle. Hier sperren: auf Admin-IPs oder mit Passwort.';

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
          label: 'Oberfläche von HAPM',
          tooltip: `HAPM ist über dieses Ziel erreichbar (${surface.url}). Es lässt sich nicht entfernen.`,
          className: 'is-muted',
        }]
      : []),
    ...(lockedCount > 0
      ? [{
          key: 'locked',
          icon: byPassword ? <KeyRound size={14} /> : <Lock size={14} />,
          label: fullyLocked
            ? byPassword
              ? 'Passwort'
              : 'Nur Admin-IPs'
            : `${lockedCount} von ${service.domains.length} gesperrt`,
          tooltip: byPassword
            ? fullyLocked
              ? 'Besucher sehen eine Passwortabfrage'
              : `Passwortabfrage für: ${service.lockedDomains.join(', ')}`
            : fullyLocked
              ? `Nur erreichbar von ${proxy.adminIps.join(', ')}`
              : `Nur von ${proxy.adminIps.join(', ')} erreichbar: ${service.lockedDomains.join(', ')}`,
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
          label: 'Verdeckt',
          tooltip:
            `Die Weiche von „${service.shadowedBy}" steht weiter oben und passt auch für diese ` +
            'Domains. HAProxy nimmt die erste, dieser Eintrag wird nie erreicht.',
          className: 'is-offline',
        }]
      : []),
    ...(service.editable
      ? []
      : [{
          key: 'readonly',
          icon: <EyeOff size={14} />,
          label: 'Nur lesbar',
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
          tooltip: HEALTH_TAG[health].tooltip,
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
          label: BALANCE_LABELS[service.balance],
          tooltip: BALANCE_HINTS[service.balance],
        }]
      : []),
    ...(service.sticky
      ? [{
          key: 'sticky',
          icon: <Cookie size={14} />,
          label: 'Sitzungsbindung',
          tooltip:
            'Ein Besucher bleibt über einen Cookie bei dem Ziel, auf dem er gelandet ist. ' +
            'HAProxy setzt ihn selbst und nimmt ihn aus der Anfrage, bevor sie hinten ankommt.',
        }]
      : []),
    /* Hinter dem Healthcheck: die Zusätze sind eine Eigenschaft, die sich nicht
     * ändert, und sie stehen im Dialog. Der Healthcheck sagt, ob der Eintrag
     * GERADE trägt. EINE Marke für alle, die Zeilen selbst stehen im Tooltip. */
    ...(addons.length > 0
      ? [{
          key: 'addons',
          icon: <SlidersHorizontal size={14} />,
          label: addons.length === 1 && service.tunnel ? 'Lange Verbindungen' : 'Header',
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
      tooltip: `Weitere Domain: ${domain}`,
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
          data-tooltip={`${service.domains.join(', ') || service.id} · Dienst-ID ${service.id}`}
        >
          <span className="rp-card-title">{service.domains[0] ?? service.id}</span>
          <span className="rp-card-subtitle">{service.id}</span>
        </div>
      </div>

      {pending && (
        <div className="rp-tags">
          <span
            className="rp-tag is-pending"
            data-tooltip="Der Vorgang läuft. Der Fortschritt steht unten rechts."
          >
            <Loader2 size={14} className="spin" />
            <span className="rp-tag-label">{removing ? `Wird entfernt · ${phaseLabel}` : phaseLabel}</span>
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
            data-tooltip="Die Domains werden nicht bedient, sondern weitergeschickt"
          >
            <CornerUpRight size={16} />
            Weiterleitung
            <span className="rp-section-count">
              {service.redirect.permanent ? '301' : '302'}
            </span>
          </div>
          <div
            className="rp-row"
            data-tooltip={
              service.redirect.keepPath
                ? `Pfad geht mit: /pfad → ${service.redirect.to}/pfad`
                : `Alles geht auf ${service.redirect.to}`
            }
          >
            <span className="rp-row-icon">
              <ArrowRight size={14} />
            </span>
            <span className="rp-row-name">{service.redirect.to}</span>
            <span className="rp-chip">
              {service.redirect.keepPath ? 'mit Pfad' : 'ohne Pfad'}
            </span>
          </div>
        </div>
      ) : (
      <div className="rp-section">
        <div
          className="rp-section-title"
          data-tooltip="Wohin alles geht, was auf keine Pfad-Regel passt"
        >
          <Server size={16} />
          Backend
        </div>
        {service.servers.length === 0 ? (
          <div className="rp-empty-line">kein Backend-Server eingetragen</div>
        ) : (
          service.servers.map((server) => (
            <div
              className="rp-row"
              key={server.name}
              data-tooltip={`${server.name} → ${server.target}`}
            >
              <span className="rp-row-icon">
                <Box size={14} />
              </span>
              <span className="rp-row-name">{server.name}</span>
              <span className="rp-chip">
                <Server size={13} />
                {server.target}
              </span>
            </div>
          ))
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
                ? 'Pfad-Regeln zuklappen'
                : `Pfade, die auf einen anderen Port gehen: ${service.routes
                    .map((r) => r.paths.join(' '))
                    .join(', ')}`
            }
          >
            {routesOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <GitBranch size={16} />
            Routen
            <span className="rp-section-count">{service.routes.length}</span>
          </button>
          {routesOpen &&
            service.routes.map((route) => (
              /* Der Tooltip nennt die VOLLE Adresse: der Chip zeigt nur den
                 Port, solange das Ziel auf derselben Maschine liegt. */
              <div
                className="rp-row rp-route"
                key={route.name}
                data-tooltip={`${route.paths.join(' ')} → ${route.servers.map((s) => s.target).join(', ')}`}
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
          aria-label={lockedCount > 0 ? 'Alle Domains öffnen' : 'Sperren'}
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
          data-tooltip={service.editable ? 'Bearbeiten' : `Nicht änderbar. ${readOnlyReason}.`}
          disabled={!service.editable || pending}
          onClick={onEdit}
          aria-label="Bearbeiten"
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
          data-tooltip="Statistik dieses Dienstes"
          aria-label="Statistik"
        >
          <BarChart3 size={16} />
        </Link>
        <button
          type="button"
          className="rp-action is-danger"
          data-tooltip={
            surface
              ? 'Nicht entfernbar: Oberfläche von HAPM. Die Adresse steht unter Allgemein.'
              : service.removable
                ? 'Löschen'
                : 'Nicht über HAPM angelegt: ACL, Weiche oder Backend folgen nicht dem erwarteten Schema'
          }
          disabled={!service.removable || surface !== null || pending}
          onClick={onDelete}
          aria-label="Löschen"
        >
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}
