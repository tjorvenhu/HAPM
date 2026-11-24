'use client';

import {
  Cable, Activity, Box, Server, Pencil, Trash2, Loader2, EyeOff, Scale, ShieldAlert, ShieldOff,
} from 'lucide-react';
import type { ServiceHealth } from '@/lib/haproxy/config';
import { STREAM_BALANCE_LABELS, type HaproxyStream } from '@/lib/haproxy/streams';
import { msgid } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';

/**
 * Eine TCP-Weiterleitung als Karte.
 *
 * Dieselbe Bauform wie `ServiceCard` und trotzdem eine eigene Datei: die Hälfte
 * dessen, was dort steht, gibt es hier nicht (Domains, Weiterleitung,
 * Pfad-Regeln, Sperre über die Admin-IPs), und dafür steht hier etwas, das es
 * dort nicht gibt — ein Port der Maschine. Eine gemeinsame Karte wäre an sechs
 * Stellen ein `if`.
 *
 * ── Die auffälligste Marke ist die offene ──
 *
 * Bei einem Dienst ist „offen für alle" der Normalfall: davor liegt ein
 * Zertifikat und dahinter eine Anwendung mit Anmeldung. Hier ist es ein Port,
 * der durchgereicht wird, und was dahinter liegt, weiß dieser Proxy nicht.
 * Deshalb trägt eine Weiterleitung ohne Absenderliste eine rote Marke und keine
 * grüne — und der Tooltip sagt, was das heißt.
 */

interface Props {
  stream: HaproxyStream;
  /** Der Eintrag wird gerade geschrieben. Bis das durch ist, steht auf der
   *  Karte noch der ALTE Stand — deshalb sagt sie das auch. */
  pendingPhase?: string | null;
  pendingKind?: 'write' | 'delete';
  /** Was HAProxys eigene Verbindungsprüfung über die Ziele sagt. `unknown`
   *  heißt: es wurde nicht geprüft, und das ist nicht „in Ordnung". */
  health: ServiceHealth;
  onEdit: () => void;
  onDelete: () => void;
}

/** Wie in `ServiceCard`: die Klassennamen stehen ausgeschrieben, weil
 *  `tests/ui/css-classes.test.ts` sie aus dem Quelltext liest. */
const HEALTH_TAG: Record<ServiceHealth, { className: string; tooltip: string }> = {
  up: { className: 'is-online', tooltip: msgid('HAProxy erreicht alle Ziele dieser Weiterleitung') },
  partial: { className: 'is-degraded', tooltip: msgid('HAProxy erreicht einen Teil der Ziele nicht') },
  down: { className: 'is-offline', tooltip: msgid('HAProxy erreicht kein Ziel dieser Weiterleitung') },
  unknown: {
    className: '',
    tooltip: msgid(
      'Der Zustand ist hier nicht bekannt: kein stats socket in der Konfiguration, kein socat oder kein check auf der server-Zeile.'
    ),
  },
};

const MAX_TAGS = 2;

export default function StreamCard({
  stream,
  pendingPhase,
  pendingKind = 'write',
  health,
  onEdit,
  onDelete,
}: Props) {
  const { t } = useT();
  const pending = pendingPhase !== undefined && pendingPhase !== null;
  const removing = pending && pendingKind === 'delete';
  const phaseLabel = pendingPhase ? t(pendingPhase) : t('Wird gestartet');

  const readOnlyReason =
    stream.extras.length > 0
      ? t('Nicht abgebildet: {extras}', { extras: stream.extras.join(' · ') })
      : t('Der Abschnitt folgt nicht dem erwarteten Schema');

  const open = stream.allowedSources.length === 0;

  const tags = [
    /* Zuerst, und rot, wenn keine Adresse dasteht: der Port ist dann von jeder
     * Adresse im Internet erreichbar, und das ist die eine Auskunft, wegen der
     * man auf so eine Karte sieht. */
    open
      ? {
          key: 'open',
          icon: <ShieldOff size={14} />,
          label: t('Von überall'),
          tooltip: t(
            'Keine Absenderliste: der Port nimmt Verbindungen von jeder Adresse an. Was dahinter liegt, ist die einzige Prüfung, die noch stattfindet.'
          ),
          className: 'is-offline',
        }
      : {
          key: 'limited',
          icon: <ShieldAlert size={14} />,
          label:
            stream.allowedSources.length === 1
              ? stream.allowedSources[0]
              : t('{count} Absender', { count: stream.allowedSources.length }),
          tooltip: t('Nur erreichbar von {addresses}. Alles andere wird abgewiesen, bevor ein Byte gelesen wird.', {
            addresses: stream.allowedSources.join(', '),
          }),
          className: 'is-locked',
        },
    ...(stream.editable
      ? []
      : [{
          key: 'readonly',
          icon: <EyeOff size={14} />,
          label: t('Nur lesbar'),
          tooltip: readOnlyReason,
          className: 'is-muted',
        }]),
    ...(stream.check || health !== 'unknown'
      ? [{
          key: 'check',
          icon: <Activity size={14} />,
          label: t('Verbindungsprüfung'),
          tooltip: t(HEALTH_TAG[health].tooltip),
          className: HEALTH_TAG[health].className,
        }]
      : []),
    ...(stream.balance
      ? [{
          key: 'balance',
          icon: <Scale size={14} />,
          label: t(STREAM_BALANCE_LABELS[stream.balance]),
          tooltip: t('Wie die Verbindungen auf die Ziele verteilt werden'),
        }]
      : []),
  ];
  const visible = tags.slice(0, MAX_TAGS);
  const hidden = tags.slice(MAX_TAGS);

  return (
    <div className="rp-card">
      <div className="rp-card-head">
        <span className="rp-card-icon">
          {pending ? <Loader2 size={20} className="spin" /> : <Cable size={20} />}
        </span>
        <div
          className="rp-card-heading"
          /* Der Firewall-Satz steht auch hier und nicht nur im Formular: nach
             dem Anlegen ist die Karte das Einzige, was man noch sieht, und
             „HAProxy lauscht" ist nicht dasselbe wie „von außen erreichbar". */
          data-tooltip={t(
            'TCP-Weiterleitung {id} · Port {port} · Erreichbar von außen nur, wenn der Port auch in der Firewall freigegeben ist',
            { id: stream.id, port: stream.port ?? t('unbekannt') }
          )}
        >
          {/* Der Port steht oben und die Kennung darunter, wie bei einem Dienst
              die Domain über der Dienst-ID: oben steht, worüber man den Eintrag
              erreicht, darunter, wie er heißt. */}
          <span className="rp-card-title">
            {stream.port === null ? t('Port unbekannt') : t('Port {port}', { port: stream.port })}
          </span>
          <span className="rp-card-subtitle">{stream.id}</span>
        </div>
      </div>

      {pending && (
        <div className="rp-tags">
          <span
            className="rp-tag is-pending"
            data-tooltip={t('Der Vorgang läuft. Fortschritt unten rechts.')}
          >
            <Loader2 size={14} className="spin" />
            <span className="rp-tag-label">
              {removing ? t('Wird entfernt · {phase}', { phase: phaseLabel }) : phaseLabel}
            </span>
          </span>
        </div>
      )}

      {!pending && (
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

      <div className="rp-section">
        <div className="rp-section-title" data-tooltip={t('Wohin die Verbindungen gehen')}>
          <Server size={16} />
          {t('Ziele')}
        </div>
        {stream.servers.length === 0 ? (
          <div className="rp-empty-line">{t('kein Ziel eingetragen')}</div>
        ) : (
          stream.servers.map((server) => (
            <div className="rp-row" key={server.name} data-tooltip={`${server.name} → ${server.target}`}>
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

      <div className="rp-actions">
        <button
          type="button"
          className="rp-action"
          data-tooltip={stream.editable ? t('Bearbeiten') : t('Nicht änderbar. {reason}.', { reason: readOnlyReason })}
          disabled={!stream.editable || pending}
          onClick={onEdit}
          aria-label={t('Bearbeiten')}
        >
          <Pencil size={16} />
        </button>
        <button
          type="button"
          className="rp-action is-danger"
          data-tooltip={
            stream.removable
              ? t('Löschen')
              : t('Steht außerhalb der Marker-Blöcke. Wo der Abschnitt anfängt, wäre geraten.')
          }
          disabled={!stream.removable || pending}
          onClick={onDelete}
          aria-label={t('Löschen')}
        >
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}
