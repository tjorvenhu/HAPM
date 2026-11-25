'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Loader2, Save, ShieldCheck, Upload } from 'lucide-react';
import { InfoHint } from '@/ui/primitives/InfoHint';
import Select from '@/components/Select';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { useConfirm } from '@/components/ConfirmDialog';
import { normalizeAcmeDirectory, validateAcmeDirectory, validateEab } from '@/lib/acme-server';
import { useT } from '@/lib/i18n/react';
// Nur der Typ: die Datei dahinter erreicht `lib/db`.
import type { SettingsView } from '@/lib/settings';
import type { CertificateSource } from '@/lib/types';

/**
 * Woher neue Zertifikate kommen: über ACME (Let's Encrypt oder ein eigener
 * Server) oder nur hochgeladen. Dieselbe Frage wie im Assistenten, gespeichert
 * über `/api/settings/certificates`.
 *
 * Ein eigener Server wird erst übernommen, wenn acme.sh ein Konto bei ihm
 * angemeldet hat; bis dahin bleibt der bisherige. Der EAB-Schlüssel steht nur
 * im Feld, bis gespeichert ist, und kommt nie zurück: acme.sh hält ihn.
 */

type Server = 'letsencrypt' | 'custom';

export default function CertificateSourceCard({
  settings,
  onSaved,
}: {
  settings: SettingsView;
  onSaved: (next: SettingsView) => void;
}) {
  const { apiFetch } = useApp();
  const { notify } = useToast();
  const confirm = useConfirm();
  const { t } = useT();

  const [source, setSource] = useState<CertificateSource>(settings.certificateSource);
  const [server, setServer] = useState<Server>(settings.acmeDirectory ? 'custom' : 'letsencrypt');
  const [directory, setDirectory] = useState(settings.acmeDirectory ?? '');
  const [eabKeyId, setEabKeyId] = useState('');
  const [eabHmacKey, setEabHmacKey] = useState('');
  const [httpReachable, setHttpReachable] = useState(settings.acmeHttpReachable);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const custom = server === 'custom';
  const url = normalizeAcmeDirectory(directory);
  const changed =
    source !== settings.certificateSource ||
    (custom ? url : null) !== settings.acmeDirectory ||
    (custom && httpReachable !== settings.acmeHttpReachable) ||
    Boolean(eabKeyId || eabHmacKey);

  async function save(event: FormEvent) {
    event.preventDefault();
    const invalid = custom ? (validateAcmeDirectory(url) ?? validateEab({ keyId: eabKeyId, hmacKey: eabHmacKey })) : null;
    if (invalid) {
      setError(t(invalid));
      return;
    }
    if (source === 'upload' && settings.certificateSource !== 'upload') {
      const confirmed = await confirm({
        title: t('Nur noch hochgeladene Zertifikate?'),
        message: t(
          'HAPM beantragt danach kein Zertifikat mehr. Ein neues Ziel lässt sich nur anlegen, wenn für seine Domains schon eins hochgeladen ist. Bestehende Zertifikate von acme.sh werden weiter erneuert.'
        ),
        confirmLabel: t('Umstellen'),
      });
      if (!confirmed) return;
    }

    setError('');
    setSaving(true);
    try {
      const res = await apiFetch('/api/settings/certificates', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source,
          acmeDirectory: custom ? url : null,
          httpReachable: custom && httpReachable,
          eabKeyId: custom ? eabKeyId : '',
          eabHmacKey: custom ? eabHmacKey : '',
        }),
      });
      const body = await res.json();
      if (!body.success) throw new Error(body.error || t('Die Einstellung ließ sich nicht speichern.'));
      onSaved(body.data.settings as SettingsView);
      setEabKeyId('');
      setEabHmacKey('');
      notify({
        variant: 'success',
        message: body.data.registered
          ? t('Gespeichert. acme.sh hat ein Konto beim ACME-Server angemeldet.')
          : t('Gespeichert. Es gilt für neue Zertifikate.'),
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('Die Einstellung ließ sich nicht speichern.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card sys-block">
      <div className="card-header">
        <div>
          <h2 className="card-title">
            <ShieldCheck size={17} strokeWidth={1.5} />
            {t('Zertifikate')}
          </h2>
          <p className="card-subtitle">{t('Woher neue Zertifikate kommen und bei welchem ACME-Server sie beantragt werden.')}</p>
        </div>
      </div>

      <form className="card-body" onSubmit={save}>
        {error && <div className="alert alert-danger">{error}</div>}

        <div className="hapm-choices">
          <button
            type="button"
            className={`hapm-choice${source === 'acme' ? ' is-selected' : ''}`}
            aria-pressed={source === 'acme'}
            disabled={saving}
            onClick={() => setSource('acme')}
          >
            <ShieldCheck size={18} strokeWidth={1.5} />
            <span className="hapm-choice-text">
              <strong>{t('Über ACME ausstellen')}</strong>
              <span>{t('HAPM beantragt Zertifikate selbst über acme.sh und erneuert sie vor dem Ablauf.')}</span>
            </span>
          </button>
          <button
            type="button"
            className={`hapm-choice${source === 'upload' ? ' is-selected' : ''}`}
            aria-pressed={source === 'upload'}
            disabled={saving}
            onClick={() => setSource('upload')}
          >
            <Upload size={18} strokeWidth={1.5} />
            <span className="hapm-choice-text">
              <strong>{t('Nur hochladen')}</strong>
              <span>
                {t('HAPM beantragt nie selbst. Zertifikate laden Sie unter Reverse-Proxy, Zertifikate hoch.')}
              </span>
            </span>
          </button>
        </div>

        {source === 'acme' && (
          <>
            <div className="form-group">
              <label className="form-label" htmlFor="acme-server">
                {t('ACME-Server')}
              </label>
              <Select<Server>
                id="acme-server"
                value={server}
                onChange={setServer}
                disabled={saving}
                options={[
                  { value: 'letsencrypt', label: "Let's Encrypt" },
                  { value: 'custom', label: t('Eigener ACME-Server') },
                ]}
              />
            </div>

            {custom && (
              <>
                <div className="form-group">
                  <label className="form-label" htmlFor="acme-directory-url">
                    {t('Directory-URL')}
                    <InfoHint
                      text={t(
                        'Die Adresse, unter der der ACME-Server sein Verzeichnis anbietet. Bei step-ca etwa https://ca.example.org/acme/acme/directory. acme.sh muss sie über HTTPS mit einem Zertifikat erreichen, dem es vertraut.'
                      )}
                    />
                  </label>
                  <input
                    id="acme-directory-url"
                    className="form-input"
                    type="text"
                    inputMode="url"
                    placeholder="https://ca.example.org/acme/acme/directory"
                    value={directory}
                    disabled={saving}
                    onChange={(e) => setDirectory(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label" htmlFor="acme-eab-kid">
                      {t('EAB Key-ID')} {t('(freiwillig)')}
                      <InfoHint
                        text={t(
                          'External Account Binding: nur nötig, wenn die CA es verlangt. Sie zeigt Key-ID und HMAC-Schlüssel beim Anlegen des Zugangs an.'
                        )}
                      />
                    </label>
                    <input
                      id="acme-eab-kid"
                      className="form-input"
                      type="text"
                      value={eabKeyId}
                      disabled={saving}
                      onChange={(e) => setEabKeyId(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="acme-eab-hmac">
                      {t('EAB HMAC-Schlüssel')} {t('(freiwillig)')}
                      <InfoHint text={t('Geht an acme.sh und wird in HAPM nicht gespeichert.')} />
                    </label>
                    <input
                      id="acme-eab-hmac"
                      className="form-input"
                      type="password"
                      value={eabHmacKey}
                      disabled={saving}
                      onChange={(e) => setEabHmacKey(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                </div>

                <label className="hapm-switch-row">
                  <span className="hapm-switch-text">
                    <span>
                      {t('Dieser ACME-Server erreicht HAPM über HTTP (Port 80)')}
                      <InfoHint
                        text={t(
                          'Wirkt nur in einer internen Installation: dann geht jedes Zertifikat über HTTP-01 statt über DNS, typisch für eine CA im selben Netz. Wildcards gehen weiter nur über DNS.'
                        )}
                      />
                    </span>
                  </span>
                  <span className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={httpReachable}
                      disabled={saving}
                      onChange={(e) => setHttpReachable(e.target.checked)}
                    />
                    <span className="toggle-slider" />
                  </span>
                </label>
              </>
            )}
          </>
        )}

        <div className="alert alert-info">
          <span>
            {t(
              'acme.sh merkt sich den Server je Zertifikat. Ein Wechsel gilt für neue Zertifikate, bestehende werden weiter beim bisherigen Server erneuert.'
            )}{' '}
            <Link href="/reverse-proxy/zertifikate">{t('Zu den Zertifikaten')}</Link>
          </span>
        </div>

        <div className="hapm-form-actions">
          <button className="btn btn-primary" type="submit" disabled={saving || !changed}>
            {saving ? <Loader2 size={16} strokeWidth={1.5} className="spin" /> : <Save size={16} strokeWidth={1.5} />}
            {t('Speichern')}
          </button>
        </div>
      </form>
    </div>
  );
}
