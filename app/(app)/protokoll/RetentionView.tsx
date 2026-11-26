'use client';

import { useState, type FormEvent } from 'react';
import { Archive, Database, Loader2, Save } from 'lucide-react';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { useConfirm } from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import { errorText } from '@/components/errorText';
import { formatCount, formatDate } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';
// Nur der Typ: die Datei dahinter erreicht `lib/db`.
import type { AuditOverview } from '@/lib/audit-log/actions';

/** Der Reiter „Aufbewahrung": wie lange Einträge bleiben, und wie viele es gerade sind. */

interface Props {
  overview: AuditOverview;
  /** Die getippte Zahl, `null` solange nichts geändert ist. Liegt in der Seite, wie die anderen Entwürfe. */
  draft: string | null;
  setDraft: (draft: string | null) => void;
  save: (patch: Record<string, unknown>) => Promise<AuditOverview>;
}

export default function RetentionView({ overview, draft, setDraft, save }: Props) {
  const { t, plural, locale } = useT();
  const { notify } = useToast();
  const confirm = useConfirm();
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const current = overview.settings.retentionDays;
  const { retentionMin, retentionMax } = overview.limits;
  const value = draft ?? String(current);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError('');
    const days = Number(value);
    if (!Number.isInteger(days) || days < retentionMin || days > retentionMax) {
      setFormError(t('Zwischen {min} und {max} Tagen.', { min: retentionMin, max: retentionMax }));
      return;
    }
    // Kürzer heißt: beim nächsten Aufräumen verschwinden Einträge für immer.
    if (days < current) {
      const confirmed = await confirm({
        title: t('Aufbewahrung verkürzen?'),
        message: t('Einträge, die älter als {days} Tage sind, entfernt HAPM beim nächsten täglichen Aufräumen. Sie lassen sich nicht zurückholen.', { days }),
        confirmLabel: t('Verkürzen'),
        variant: 'warning',
      });
      if (!confirmed) return;
    }
    setSaving(true);
    try {
      await save({ retentionDays: days });
      setDraft(null);
      notify({
        variant: 'success',
        message: plural(days, {
          one: 'Das Protokoll wird einen Tag aufgehoben.',
          other: 'Das Protokoll wird {count} Tage aufgehoben.',
        }),
      });
    } catch (err: unknown) {
      notify({
        variant: 'error',
        title: t('Speichern fehlgeschlagen'),
        message: errorText(err, t('Die Aufbewahrung ließ sich nicht speichern.')),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="hapm-fit">
      <div className="hapm-main-side sys-block">
        <div className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">
                <Archive size={17} strokeWidth={1.5} />
                {t('Aufbewahrung')}
                <InfoHint text={t('Einmal am Tag entfernt HAPM, was älter ist. Was bis dahin an ein SIEM weitergeleitet oder exportiert wurde, bleibt dort erhalten.')} />
              </h2>
              <p className="card-subtitle">{t('Wie lange ein Eintrag im Protokoll bleibt.')}</p>
            </div>
          </div>

          <form className="card-body" onSubmit={submit}>
            {formError && <div className="alert alert-danger">{formError}</div>}
            <div className="form-group">
              <label className="form-label" htmlFor="audit-retention">{t('Tage')}</label>
              <input
                id="audit-retention"
                className="form-input"
                type="text"
                inputMode="numeric"
                value={value}
                disabled={saving}
                onChange={(event) => setDraft(event.target.value.replace(/\D/g, '').slice(0, 4))}
                autoComplete="off"
              />
              <p className="form-hint">{t('Zwischen {min} und {max} Tagen.', { min: retentionMin, max: retentionMax })}</p>
            </div>
            <div className="hapm-form-actions">
              <button className="btn btn-primary" type="submit" disabled={saving || draft === null || draft === String(current)}>
                {saving ? <Loader2 size={16} strokeWidth={1.5} className="spin" /> : <Save size={16} strokeWidth={1.5} />}
                {t('Speichern')}
              </button>
            </div>
          </form>
        </div>

        <div className="hapm-side">
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">
                <Database size={17} strokeWidth={1.5} />
                {t('Bestand')}
              </h2>
            </div>
            <div className="dash-kv">
              <div className="dash-kv-row">
                <span className="dash-kv-label">{t('Einträge')}</span>
                <span className="dash-kv-value">{formatCount(locale, overview.totals.count)}</span>
              </div>
              <div className="dash-kv-row">
                <span className="dash-kv-label">{t('Ältester Eintrag')}</span>
                <span className={`dash-kv-value ${overview.totals.oldest ? '' : 'muted'}`}>
                  {overview.totals.oldest ? formatDate(locale, overview.totals.oldest) : t('Noch keiner')}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
