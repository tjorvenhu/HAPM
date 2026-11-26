'use client';

import { useState, type FormEvent } from 'react';
import { CheckCircle2, Loader2, Plus, Trash2, UserCheck } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { useConfirm } from '@/components/ConfirmDialog';
import Select from '@/components/Select';
import { SkeletonRows } from '@/components/Skeleton';
import { ALLOW_DURATIONS, parseAddress } from '@/lib/crowdsec/data';
import { formatDateTime, msgid } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';
import { useCrowdsecData, useCrowdsecSend } from './useCrowdsecData';
import { DURATION_LABELS } from './DecisionsPanel';
import type { AllowlistEntry } from './types';

type AllowChoice = 'always' | (typeof ALLOW_DURATIONS)[number];

const ALWAYS = msgid('Unbefristet');

/**
 * Die Freigabeliste. Eine freigegebene Adresse sperrt CrowdSec nicht, und
 * HAProxy fragt für sie gar nicht erst bei CrowdSec nach (auch nicht bei der
 * WAF, siehe `lib/crowdsec/allow-file.ts`).
 */
export default function AllowlistPanel({ client }: { client: string | null }) {
  const { notify } = useToast();
  const confirm = useConfirm();
  const send = useCrowdsecSend();
  const { t, locale } = useT();
  const { data, error, loading, reload } = useCrowdsecData<{ entries: AllowlistEntry[] }>('/api/crowdsec/allowlist', 60_000);
  const [value, setValue] = useState('');
  const [description, setDescription] = useState('');
  const [duration, setDuration] = useState<AllowChoice>('always');
  const [busy, setBusy] = useState(false);
  const valid = value.trim() === '' || parseAddress(value) !== null;
  const entries = data?.entries ?? [];
  const clientListed = client !== null && entries.some((entry) => entry.value === client);
  const clientUsable = client !== null && parseAddress(client) !== null;

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!parseAddress(value)) return;
    setBusy(true);
    try {
      await send('/api/crowdsec/allowlist', 'POST', {
        value: value.trim(),
        description,
        duration: duration === 'always' ? null : duration,
      });
      notify({ variant: 'success', message: t('{value} ist freigegeben.', { value: value.trim() }) });
      setValue('');
      setDescription('');
      await reload();
    } catch (err) {
      notify({ variant: 'error', title: t('Freigeben fehlgeschlagen'), message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  function remove(entry: AllowlistEntry) {
    void confirm({
      title: t('Freigabe entfernen?'),
      message:
        entry.value === client
          ? t('{value} ist die eigene Adresse. Danach prüft CrowdSec auch die eigenen Anfragen und kann sie sperren.', {
              value: entry.value,
            })
          : t('Danach prüft CrowdSec die Anfragen von {value} wieder.', { value: entry.value }),
      confirmLabel: t('Entfernen'),
      variant: 'danger',
      onConfirm: async () => {
        try {
          await send('/api/crowdsec/allowlist', 'DELETE', { value: entry.value });
          notify({ variant: 'success', message: t('Die Freigabe für {value} ist entfernt.', { value: entry.value }) });
          await reload();
        } catch (err) {
          notify({ variant: 'error', title: t('Entfernen fehlgeschlagen'), message: err instanceof Error ? err.message : String(err) });
        }
      },
    });
  }

  return (
    <>
      <div className="card sys-block">
        <div className="card-header">
          <div>
            <h2 className="card-title">{t('Adresse freigeben')}</h2>
            <p className="card-subtitle">
              {t('Freigegebene Adressen sperrt CrowdSec nicht, und die WAF prüft sie nicht.')}
            </p>
          </div>
          {clientUsable && !clientListed && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => {
              setValue(client!);
              setDescription(t('Eigene Adresse'));
            }}>
              <UserCheck size={14} />
              {t('Eigene Adresse eintragen')}
            </button>
          )}
        </div>
        <form className="card-body cs-form" onSubmit={add}>
          <div className="form-group">
            <label className="form-label" htmlFor="cs-allow-value">{t('Adresse')}</label>
            <input
              id="cs-allow-value"
              className="form-input mono"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="198.51.100.0/24"
              aria-invalid={!valid}
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="cs-allow-duration">{t('Gilt')}</label>
            <Select<AllowChoice>
              id="cs-allow-duration"
              value={duration}
              onChange={setDuration}
              options={[
                { value: 'always', label: t(ALWAYS) },
                ...ALLOW_DURATIONS.map((d) => ({ value: d, label: t(DURATION_LABELS[d]) })),
              ]}
            />
          </div>
          <div className="form-group cs-form-wide">
            <label className="form-label" htmlFor="cs-allow-description">{t('Beschreibung')}</label>
            <input
              id="cs-allow-description"
              className="form-input"
              value={description}
              maxLength={120}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('Büro, Monitoring, Partner')}
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy || !value.trim() || !valid}>
            {busy ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
            {t('Freigeben')}
          </button>
        </form>
        {!valid && <p className="form-hint is-error">{t('Das ist keine Adresse und kein Netz.')}</p>}
      </div>

      {error && <div className="alert alert-danger sys-block">{error}</div>}

      <div className="card sys-block">
        <div className="card-header">
          <h2 className="card-title">
            {t('Freigaben')}
            {data && <span className="section-count">{entries.length}</span>}
          </h2>
        </div>
        {loading && !data ? (
          <SkeletonRows />
        ) : entries.length === 0 ? (
          <div className="empty-state">
            <CheckCircle2 size={36} />
            <h3>{t('Keine Freigabe')}</h3>
            <p>{t('CrowdSec prüft alle Adressen.')}</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('Adresse')}</th>
                  <th>{t('Beschreibung')}</th>
                  <th>{t('Seit')}</th>
                  <th>{t('Gilt bis')}</th>
                  <th aria-label={t('Aktionen')} />
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.value}>
                    <td data-label="primary">
                      <strong className="mono">{entry.value}</strong>
                      {entry.value === client && <div className="detail-sub">{t('Eigene Adresse')}</div>}
                    </td>
                    <td data-label={t('Beschreibung')}>{entry.description}</td>
                    <td data-label={t('Seit')}>{entry.createdAt ? formatDateTime(locale, entry.createdAt) : ''}</td>
                    <td data-label={t('Gilt bis')}>{entry.expiresAt ? formatDateTime(locale, entry.expiresAt) : t(ALWAYS)}</td>
                    <td data-label="actions">
                      <div className="actions hapm-actions-end">
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon btn-sm"
                          data-tooltip={t('Entfernen')}
                          data-tooltip-pos="left"
                          aria-label={t('Entfernen')}
                          onClick={() => remove(entry)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
