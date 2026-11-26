'use client';

import { useState, type FormEvent } from 'react';
import ErrorNote from '@/components/ErrorNote';
import { createPortal } from 'react-dom';
import { RotateCw, X } from 'lucide-react';
import Select from '@/components/Select';
import { errorText } from '@/components/errorText';
import { useT } from '@/lib/i18n/react';

/**
 * Einen nie ausgestellten Antrag von acme.sh noch einmal stellen.
 *
 * Ein Dialog und keine Bestätigung, weil bei mehreren DNS-Hooks einer gewählt
 * werden muss: welcher Anbieter die Zone führt, lässt sich nicht raten. Mit
 * einem Hook oder keinem steht keine Auswahl da, die Route nimmt dann den
 * einen selbst (wie beim Anlegen eines Ziels).
 *
 * Der Lauf geht abgekoppelt weiter; die Pille unten rechts zeigt ihn.
 *
 * Wirft `onIssue`, bleibt der Dialog mit seiner Auswahl offen. Die Meldung geht
 * an `onError` (die Seite zeigt sie als Toast), ohne `onError` steht sie im Dialog.
 */

interface Props {
  mainDomain: string;
  domains: string[];
  dnsHooks: string[];
  onIssue: (dnsHook: string | null) => Promise<void>;
  onError?: (message: string) => void;
  onClose: () => void;
}

export default function CertificateIssueDialog({ mainDomain, domains, dnsHooks, onIssue, onError, onClose }: Props) {
  const { t } = useT();
  const [dnsHook, setDnsHook] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const chooseHook = dnsHooks.length > 1;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (chooseHook && !dnsHook) {
      setError(t('Bitte wählen Sie den DNS-Hook, der die Challenge setzt.'));
      return;
    }
    setError('');
    setSaving(true);
    try {
      await onIssue(dnsHook);
    } catch (err: unknown) {
      const text = errorText(err, t('Der Antrag ließ sich nicht starten.'));
      if (onError) onError(text);
      else setError(text);
      setSaving(false);
    }
  }

  return createPortal(
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && !saving && onClose()}>
      <form className="modal" onSubmit={submit}>
        <div className="modal-header">
          <h2 className="modal-title">
            {t('Erneut beantragen')}
            <span className="modal-subject">{mainDomain}</span>
          </h2>
          <button type="button" className="modal-close" onClick={onClose} disabled={saving} aria-label={t('Dialog schließen')}>
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          <p className="form-hint">
            {t('Gilt für {domains}. Ziele mit eigenem Zertifikat behalten es.', { domains: domains.join(', ') })}
          </p>

          {chooseHook && (
            <div className="form-group">
              <label className="form-label">{t('DNS-Hook')}</label>
              <Select
                value={dnsHook}
                onChange={setDnsHook}
                options={dnsHooks.map((hook) => ({ value: hook, label: hook }))}
                placeholder={t('Bitte wählen')}
                disabled={saving}
              />
            </div>
          )}

          {error && <div className="alert alert-danger"><ErrorNote text={error} /></div>}
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
            {t('Abbrechen')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? <span className="btn-spinner" aria-hidden="true" /> : <RotateCw size={16} />}
            {t('Beantragen')}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}
