'use client';

import { useState } from 'react';
import { Check, Download, Loader2 } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { useConfirm } from '@/components/ConfirmDialog';
import Select from '@/components/Select';
import { SkeletonRows } from '@/components/Skeleton';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { msgid } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';
import { useCrowdsecData, useCrowdsecSend } from './useCrowdsecData';
import type { CrowdsecRules, CrsMode } from './types';

const CRS_OPTIONS: { value: CrsMode; label: string; hint: string }[] = [
  { value: 'off', label: msgid('Aus'), hint: msgid('Nur virtuelle Patches und allgemeine Regeln.') },
  { value: 'detect', label: msgid('Nur melden'), hint: msgid('Treffer erscheinen als Ereignis, die Anfrage geht durch.') },
  { value: 'block', label: msgid('Treffer sperren'), hint: msgid('Treffer werden mit 403 abgelehnt.') },
];

const BASE_LABELS: Record<string, string> = {
  'crowdsecurity/haproxy': msgid('Log von HAProxy: Scanner, Raten von Passwörtern, bekannte Lücken'),
  'crowdsecurity/appsec-virtual-patching': msgid('WAF: virtuelle Patches für bekannte Lücken'),
  'crowdsecurity/appsec-generic-rules': msgid('WAF: allgemeine Angriffsmuster'),
};

/**
 * Welche Regeln CrowdSec anwendet. Die Grundausstattung bringt Compose mit,
 * dazuschalten lässt sich eine feste Auswahl (`OPTIONAL_COLLECTIONS`) und das
 * OWASP Core Rule Set.
 */
export default function RulesPanel() {
  const { notify } = useToast();
  const confirm = useConfirm();
  const send = useCrowdsecSend();
  const { t } = useT();
  const { data, error, loading, reload } = useCrowdsecData<CrowdsecRules>('/api/crowdsec/rules', 120_000);
  const [busy, setBusy] = useState<string | null>(null);

  async function change(key: string, body: unknown, done: string) {
    setBusy(key);
    try {
      await send('/api/crowdsec/rules', 'PATCH', body);
      notify({ variant: 'success', message: done });
      await reload();
    } catch (err) {
      notify({ variant: 'error', title: t('Ändern fehlgeschlagen'), message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  function setCrs(mode: CrsMode) {
    if (mode === 'block') {
      void confirm({
        title: t('OWASP-Regeln sperren lassen?'),
        message: t(
          'Das OWASP Core Rule Set ist streng und sperrt auch harmlose Anfragen, etwa Formulare mit Code oder SQL im Text. Besser erst einige Tage „Nur melden“ und die Ereignisse ansehen.'
        ),
        confirmLabel: t('Sperren lassen'),
        variant: 'warning',
        onConfirm: () => change('crs', { crs: mode }, t('Die OWASP-Regeln sperren jetzt.')),
      });
      return;
    }
    void change('crs', { crs: mode }, t('Gespeichert. CrowdSec lädt die Regeln neu.'));
  }

  if (loading && !data) return <SkeletonRows />;

  return (
    <>
      {error && <div className="alert alert-danger sys-block">{error}</div>}
      {data && (
        <>
          <div className="card sys-block">
            <div className="card-header">
              <div>
                <h2 className="card-title">{t('OWASP Core Rule Set')}</h2>
                <p className="card-subtitle">{t('Allgemeine Regeln gegen SQL-Injection, XSS und ähnliche Angriffe.')}</p>
              </div>
            </div>
            <div className="card-body cs-form">
              <div className="form-group cs-form-wide">
                <label className="form-label" htmlFor="cs-crs">{t('Modus')}</label>
                <Select<CrsMode>
                  id="cs-crs"
                  value={data.crs}
                  onChange={setCrs}
                  disabled={busy !== null}
                  options={CRS_OPTIONS.map((o) => ({ value: o.value, label: t(o.label), hint: t(o.hint) }))}
                />
              </div>
              {busy === 'crs' && <Loader2 size={16} className="spin" />}
            </div>
          </div>

          <div className="card sys-block">
            <div className="card-header">
              <div>
                <h2 className="card-title">{t('Regelsammlungen')}</h2>
                <p className="card-subtitle">{t('Aus dem Hub von CrowdSec.')}</p>
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={busy !== null}
                onClick={() => change('hub', { upgrade: true }, t('Die Regeln sind auf dem neuesten Stand.'))}
              >
                {busy === 'hub' ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
                {t('Regeln aktualisieren')}
              </button>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('Sammlung')}</th>
                    <th>{t('Version')}</th>
                    <th>{t('Aktiv')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.base.map((entry) => (
                    <tr key={entry.name}>
                      <td data-label="primary">
                        <strong>{t(BASE_LABELS[entry.name] ?? entry.name)}</strong>
                        <div className="detail-sub mono">{entry.name}</div>
                      </td>
                      <td data-label={t('Version')}>{entry.version ?? ''}</td>
                      <td data-label={t('Aktiv')}>
                        {entry.installed ? (
                          <span className="badge-status badge-success">
                            <Check size={12} />
                            {t('Immer an')}
                          </span>
                        ) : (
                          <span className="badge-status badge-warning">{t('Fehlt')}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {data.optional.map((entry) => (
                    <tr key={entry.name}>
                      <td data-label="primary">
                        <span className="form-label-row">
                          <strong>{t(entry.label)}</strong>
                          <InfoHint text={t(entry.hint)} />
                        </span>
                        <div className="detail-sub mono">{entry.name}</div>
                      </td>
                      <td data-label={t('Version')}>{entry.version ?? ''}</td>
                      <td data-label={t('Aktiv')}>
                        <label className="toggle-switch">
                          <input
                            type="checkbox"
                            checked={entry.installed}
                            disabled={busy !== null}
                            onChange={(e) =>
                              change(
                                entry.name,
                                { name: entry.name, installed: e.target.checked },
                                e.target.checked ? t('{name} ist an.', { name: t(entry.label) }) : t('{name} ist aus.', { name: t(entry.label) })
                              )
                            }
                            aria-label={t(entry.label)}
                          />
                          <span className="toggle-slider" />
                        </label>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}
