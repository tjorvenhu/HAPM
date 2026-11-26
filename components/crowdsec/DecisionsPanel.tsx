'use client';

import { useState, type FormEvent } from 'react';
import { Ban, CheckCircle2, Loader2, Plus, Unlock } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { useConfirm } from '@/components/ConfirmDialog';
import Select from '@/components/Select';
import CountryFlag from '@/components/CountryFlag';
import { SkeletonRows } from '@/components/Skeleton';
import { BAN_DURATIONS, parseAddress, type BanDuration } from '@/lib/crowdsec/data';
import { formatDateTime, formatRelative, msgid } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';
import { useNow } from '@/components/useNow';
import { useCrowdsecData, useCrowdsecSend } from './useCrowdsecData';
import type { CrowdsecDecision } from './types';

export const DURATION_LABELS: Record<string, string> = {
  '1h': msgid('1 Stunde'),
  '4h': msgid('4 Stunden'),
  '24h': msgid('1 Tag'),
  '168h': msgid('7 Tage'),
  '720h': msgid('30 Tage'),
  '8760h': msgid('1 Jahr'),
};

const ORIGIN_LABELS: Record<string, string> = {
  crowdsec: msgid('Erkannt'),
  cscli: msgid('Von Hand'),
  CAPI: msgid('Gemeinschaftsliste'),
  lists: msgid('Blockliste'),
  appsec: msgid('WAF'),
};

/**
 * Die aktiven Sperren: aufheben, freigeben, von Hand sperren. Die
 * Gemeinschaftsliste steht nicht darin (Zehntausende Adressen), nur ihre
 * Größe auf der Übersicht.
 */
export default function DecisionsPanel({ onFreed }: { onFreed?: () => void }) {
  const { notify } = useToast();
  const confirm = useConfirm();
  const send = useCrowdsecSend();
  const { t, plural, locale } = useT();
  const { data, error, loading, reload } = useCrowdsecData<{ decisions: CrowdsecDecision[] }>('/api/crowdsec/decisions', 20_000);
  const [value, setValue] = useState('');
  const [duration, setDuration] = useState<BanDuration>('24h');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const now = useNow(30_000);
  const valid = value.trim() === '' || parseAddress(value) !== null;

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!parseAddress(value)) return;
    setBusy(true);
    try {
      await send('/api/crowdsec/decisions', 'POST', { value: value.trim(), duration, reason });
      notify({ variant: 'success', message: t('{value} ist gesperrt.', { value: value.trim() }) });
      setValue('');
      setReason('');
      await reload();
    } catch (err) {
      notify({ variant: 'error', title: t('Sperren fehlgeschlagen'), message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  function remove(decision: CrowdsecDecision) {
    void confirm({
      title: t('Sperre aufheben?'),
      message: t('{value} kommt danach wieder durch, bis CrowdSec die Adresse erneut erkennt.', { value: decision.value }),
      confirmLabel: t('Aufheben'),
      variant: 'warning',
      onConfirm: async () => {
        try {
          await send('/api/crowdsec/decisions', 'DELETE', { id: decision.id });
          notify({ variant: 'success', message: t('Die Sperre für {value} ist aufgehoben.', { value: decision.value }) });
          await reload();
        } catch (err) {
          notify({ variant: 'error', title: t('Aufheben fehlgeschlagen'), message: err instanceof Error ? err.message : String(err) });
        }
      },
    });
  }

  function allow(decision: CrowdsecDecision) {
    void confirm({
      title: t('Adresse freigeben?'),
      message: t(
        '{value} kommt danach immer durch: CrowdSec sperrt die Adresse nicht mehr, und HAProxy fragt für sie nicht bei der WAF nach. Bestehende Sperren hebt CrowdSec dabei auf.',
        { value: decision.value }
      ),
      confirmLabel: t('Freigeben'),
      onConfirm: async () => {
        try {
          await send('/api/crowdsec/allowlist', 'POST', { value: decision.value, description: decision.reason });
          notify({ variant: 'success', message: t('{value} ist freigegeben.', { value: decision.value }) });
          await reload();
          onFreed?.();
        } catch (err) {
          notify({ variant: 'error', title: t('Freigeben fehlgeschlagen'), message: err instanceof Error ? err.message : String(err) });
        }
      },
    });
  }

  const decisions = data?.decisions ?? [];

  return (
    <>
      <div className="card sys-block">
        <div className="card-header">
          <div>
            <h2 className="card-title">{t('Adresse sperren')}</h2>
            <p className="card-subtitle">{t('Eine Adresse oder ein Netz, etwa 203.0.113.7 oder 198.51.100.0/24.')}</p>
          </div>
        </div>
        <form className="card-body cs-form" onSubmit={add}>
          <div className="form-group">
            <label className="form-label" htmlFor="cs-ban-value">{t('Adresse')}</label>
            <input
              id="cs-ban-value"
              className="form-input mono"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="203.0.113.7"
              aria-invalid={!valid}
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="cs-ban-duration">{t('Dauer')}</label>
            <Select
              id="cs-ban-duration"
              value={duration}
              onChange={setDuration}
              options={BAN_DURATIONS.map((d) => ({ value: d, label: t(DURATION_LABELS[d]) }))}
            />
          </div>
          <div className="form-group cs-form-wide">
            <label className="form-label" htmlFor="cs-ban-reason">{t('Grund')}</label>
            <input
              id="cs-ban-reason"
              className="form-input"
              value={reason}
              maxLength={120}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('Gesperrt in HAPM')}
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy || !value.trim() || !valid}>
            {busy ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
            {t('Adresse sperren')}
          </button>
        </form>
        {!valid && <p className="form-hint is-error">{t('Das ist keine Adresse und kein Netz.')}</p>}
      </div>

      {error && <div className="alert alert-danger sys-block">{error}</div>}

      <div className="card sys-block">
        <div className="card-header">
          <div>
            <h2 className="card-title">
              {t('Aktive Sperren')}
              {data && <span className="section-count">{decisions.length}</span>}
            </h2>
            <p className="card-subtitle">{t('Gesperrte Adressen bekommen von jedem geprüften Ziel eine 403.')}</p>
          </div>
        </div>
        {loading && !data ? (
          <SkeletonRows />
        ) : !data ? (
          <p className="form-hint">{t('Ohne Verbindung zu CrowdSec sind die Sperren unbekannt.')}</p>
        ) : decisions.length === 0 ? (
          <div className="empty-state">
            <CheckCircle2 size={36} />
            <h3>{t('Keine Sperre')}</h3>
            <p>{t('Gerade ist keine Adresse von CrowdSec oder von Hand gesperrt.')}</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('Adresse')}</th>
                  <th>{t('Grund')}</th>
                  <th>{t('Herkunft')}</th>
                  <th>{t('Seit')}</th>
                  <th>{t('Endet')}</th>
                  <th aria-label={t('Aktionen')} />
                </tr>
              </thead>
              <tbody>
                {decisions.map((decision) => (
                  <tr key={decision.id}>
                    <td data-label="primary">
                      <span className="hapm-brand">
                        {decision.country && <CountryFlag code={decision.country} />}
                        <strong className="mono">{decision.value}</strong>
                      </span>
                      {decision.asName && <div className="detail-sub">{decision.asName}</div>}
                    </td>
                    <td data-label={t('Grund')}>
                      <span className="mono">{decision.reason}</span>
                      {decision.type !== 'ban' && <div className="detail-sub">{decision.type}</div>}
                    </td>
                    <td data-label={t('Herkunft')}>
                      {ORIGIN_LABELS[decision.origin] ? t(ORIGIN_LABELS[decision.origin]) : decision.origin}
                    </td>
                    <td data-label={t('Seit')}>
                      {decision.createdAt ? (
                        <span data-tooltip={formatDateTime(locale, decision.createdAt)}>
                          {formatRelative(locale, now, decision.createdAt)}
                        </span>
                      ) : (
                        t('Unbekannt')
                      )}
                    </td>
                    <td data-label={t('Endet')}>
                      {decision.until ? formatDateTime(locale, decision.until) : t('Unbekannt')}
                    </td>
                    <td data-label="actions">
                      <div className="actions hapm-actions-end">
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon btn-sm"
                          data-tooltip={t('Freigeben')}
                          data-tooltip-pos="left"
                          aria-label={t('Freigeben')}
                          onClick={() => allow(decision)}
                        >
                          <CheckCircle2 size={16} />
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon btn-sm"
                          data-tooltip={t('Sperre aufheben')}
                          data-tooltip-pos="left"
                          aria-label={t('Sperre aufheben')}
                          onClick={() => remove(decision)}
                        >
                          <Unlock size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {decisions.length > 0 && (
          <p className="form-hint">
            <Ban size={14} />{' '}
            {plural(decisions.length, { one: '{count} Sperre aktiv.', other: '{count} Sperren aktiv.' })}
          </p>
        )}
      </div>
    </>
  );
}
