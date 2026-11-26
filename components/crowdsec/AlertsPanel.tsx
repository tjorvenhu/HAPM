'use client';

import { useMemo } from 'react';
import ErrorNote from '@/components/ErrorNote';
import { CheckCircle2, Eraser, X } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { useConfirm } from '@/components/ConfirmDialog';
import Select from '@/components/Select';
import CountryFlag from '@/components/CountryFlag';
import { SkeletonRows } from '@/components/Skeleton';
import { MISSING, formatDateTime, formatNumber, formatRelative, msgid } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';
import { useNow } from '@/components/useNow';
import { useCrowdsecData, useCrowdsecSend } from './useCrowdsecData';
import type { CrowdsecAlertRow } from './types';

export const WINDOWS = ['24h', '7d', '30d'] as const;
export type AlertWindow = (typeof WINDOWS)[number];
export const WINDOW_LABELS: Record<AlertWindow, string> = {
  '24h': msgid('Letzte 24 Stunden'),
  '7d': msgid('Letzte 7 Tage'),
  '30d': msgid('Letzte 30 Tage'),
};

export const KIND_LABELS: Record<CrowdsecAlertRow['kind'], { label: string; cls: string }> = {
  waf: { label: msgid('WAF'), cls: 'badge-danger' },
  scenario: { label: msgid('Szenario'), cls: 'badge-warning' },
  manual: { label: msgid('Von Hand'), cls: 'badge-neutral' },
  other: { label: msgid('Sonstiges'), cls: 'badge-neutral' },
};

const ALL = '__alle__';

/**
 * Die Ereignisse: WAF-Treffer (eine abgelehnte Anfrage), Szenarien aus dem Log
 * (eine erkannte Adresse, meist mit Sperre) und Sperren von Hand. Jedes trägt
 * das Ziel, soweit es sich zuordnen lässt; `target` filtert auf eines.
 */
export default function AlertsPanel({
  period,
  onPeriod,
  target,
  onTarget,
  targets,
  onCleared,
}: {
  period: AlertWindow;
  onPeriod: (next: AlertWindow) => void;
  target: string | null;
  onTarget: (next: string | null) => void;
  /** Ziele für die Auswahl: Kennung und Hauptdomain. */
  targets: { id: string; label: string }[];
  /** Nach dem Leeren: die Seite liest Übersicht und Zahlen neu. */
  onCleared?: () => void;
}) {
  const { t, plural, locale } = useT();
  const path = `/api/crowdsec/alerts?window=${period}${target ? `&service=${encodeURIComponent(target)}` : ''}`;
  const { notify } = useToast();
  const confirm = useConfirm();
  const send = useCrowdsecSend();
  const { data, error, loading, reload } = useCrowdsecData<{ alerts: CrowdsecAlertRow[]; truncated?: boolean }>(path, 30_000);
  const now = useNow(30_000);
  const labelOf = useMemo(() => new Map(targets.map((entry) => [entry.id, entry.label])), [targets]);
  const options = [
    { value: ALL, label: t('Alle Ziele') },
    ...targets.map((entry) => ({ value: entry.id, label: entry.label, hint: entry.id })),
    ...(target && !labelOf.has(target) ? [{ value: target, label: target }] : []),
  ];
  const alerts = data?.alerts ?? [];

  function askClear() {
    void confirm({
      title: t('CrowdSec leeren?'),
      message: t(
        'Entfernt alle Ereignisse und hebt die Sperren auf, die CrowdSec daraus verhängt hat. Statistik und Zähler beginnen bei null. Sperren von Hand, Freigaben, Regeln und die Gemeinschaftsliste bleiben. Das dauert bis zu einer Minute.'
      ),
      confirmLabel: t('Leeren'),
      variant: 'danger',
      failedTitle: t('Leeren fehlgeschlagen'),
      onConfirm: async () => {
        const result = await send<{ alerts: number; lifted: number; kept: number; lost: string[] }>('/api/crowdsec/alerts', 'DELETE', {});
        if (result.lost.length > 0) {
          notify({
            variant: 'warning',
            title: t('CrowdSec ist geleert'),
            message: t('Diese Sperren von Hand ließen sich nicht wieder setzen: {values}', { values: result.lost.join(', ') }),
          });
        } else {
          notify({
            variant: 'success',
            title: t('CrowdSec ist geleert'),
            message: [
              t('{alerts} Ereignisse entfernt, {bans} Sperren aufgehoben.', {
                alerts: formatNumber(locale, result.alerts),
                bans: formatNumber(locale, result.lifted),
              }),
              result.kept > 0
                ? plural(result.kept, {
                    one: '{count} Sperre von Hand gilt weiter.',
                    other: '{count} Sperren von Hand gelten weiter.',
                  })
                : '',
            ]
              .filter(Boolean)
              .join(' '),
          });
        }
        await reload();
        onCleared?.();
      },
    });
  }

  return (
    <div className="card sys-block">
      <div className="card-header">
        <div>
          <h2 className="card-title">
            {t('Ereignisse')}
            {data && <span className="section-count">{alerts.length}</span>}
          </h2>
          <p className="card-subtitle">
            {target
              ? t('Nur die Ereignisse von {target}.', { target: labelOf.get(target) ?? target })
              : t('WAF-Treffer, Szenarien aus dem Log von HAProxy und Sperren von Hand.')}
          </p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={askClear}>
          <Eraser size={14} />
          {t('CrowdSec leeren')}
        </button>
      </div>
      <div className="card-body cs-form">
        <div className="form-group">
          <label className="form-label" htmlFor="cs-alert-window">{t('Zeitraum')}</label>
          <Select<AlertWindow>
            id="cs-alert-window"
            value={period}
            onChange={onPeriod}
            options={WINDOWS.map((w) => ({ value: w, label: t(WINDOW_LABELS[w]) }))}
          />
        </div>
        <div className="form-group cs-form-wide">
          <label className="form-label" htmlFor="cs-alert-target">{t('Ziel')}</label>
          <Select<string>
            id="cs-alert-target"
            value={target ?? ALL}
            onChange={(next) => onTarget(next === ALL ? null : next)}
            options={options}
            searchable={options.length > 8}
          />
        </div>
        {target && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onTarget(null)}>
            <X size={14} />
            {t('Filter entfernen')}
          </button>
        )}
      </div>

      {error && <div className="alert alert-danger cs-card-alert"><ErrorNote text={error} /></div>}
      {data?.truncated && (
        <div className="alert alert-info cs-card-alert">
          {t('Im Zeitraum gibt es mehr Ereignisse, als hier Platz haben. Gezeigt sind die neuesten. Ein kürzerer Zeitraum oder ein einzelnes Ziel zeigt alle.')}
        </div>
      )}

      {loading && !data ? (
        <SkeletonRows />
      ) : !data ? null : alerts.length === 0 ? (
        <div className="empty-state">
          <CheckCircle2 size={36} />
          <h3>{t('Keine Ereignisse')}</h3>
          <p>{t('Im gewählten Zeitraum hat CrowdSec nichts gemeldet.')}</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table table-cards cs-alerts">
            <thead>
              <tr>
                <th>{t('Zeitpunkt')}</th>
                <th>{t('Art')}</th>
                <th>{t('Was')}</th>
                <th>{t('Von')}</th>
                <th>{t('Ziel')}</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((alert) => (
                <tr key={alert.id}>
                  <td data-label={t('Zeitpunkt')}>
                    {alert.createdAt ? (
                      <span data-tooltip={formatDateTime(locale, alert.createdAt)}>
                        {formatRelative(locale, now, alert.createdAt)}
                      </span>
                    ) : (
                      MISSING
                    )}
                  </td>
                  <td data-label={t('Art')}>
                    <span className={`badge-status ${KIND_LABELS[alert.kind].cls}`}>
                      {t(KIND_LABELS[alert.kind].label)}
                    </span>
                    {alert.decisions > 0 && <div className="detail-sub">{t('mit Sperre')}</div>}
                  </td>
                  <td data-label="primary">
                    <strong className="mono">{alert.scenario}</strong>
                    {(alert.method || alert.paths.length > 0) && (
                      <div className="detail-sub mono">
                        {[alert.method, alert.paths[0]].filter(Boolean).join(' ')}
                        {alert.paths.length > 1 ? ' …' : ''}
                      </div>
                    )}
                    {alert.eventsCount > 1 && (
                      <div className="detail-sub">
                        {plural(alert.eventsCount, { one: '{count} Anfrage', other: '{count} Anfragen' })}
                      </div>
                    )}
                  </td>
                  <td data-label={t('Von')}>
                    <span className="hapm-brand">
                      {alert.country && <CountryFlag code={alert.country} />}
                      <span className="mono">{alert.source}</span>
                    </span>
                    {alert.asName && <div className="detail-sub">{alert.asName}</div>}
                  </td>
                  <td data-label={t('Ziel')}>
                    {alert.targetId ? (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onTarget(alert.targetId)}>
                        {labelOf.get(alert.targetId) ?? alert.targetId}
                      </button>
                    ) : (
                      <span className="hapm-muted">{alert.targetHost ?? alert.targetBackend ?? t('Ohne Ziel')}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
