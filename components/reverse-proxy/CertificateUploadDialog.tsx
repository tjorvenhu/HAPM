'use client';

import { useRef, useState, type FormEvent } from 'react';
import { FileUp, Upload, X } from 'lucide-react';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { useT } from '@/lib/i18n/react';

/**
 * Ein Zertifikat samt Schlüssel hochladen oder ein hochgeladenes ersetzen.
 *
 * Ein Baustein für zwei Stellen: die Zertifikatsseite (mit `apiFetch`) und den
 * Schritt „Einrichten" des Assistenten (mit seinem `call()`, er steht außerhalb
 * der App-Hülle). Deshalb schickt der Dialog nicht selbst, sondern ruft
 * `onUpload`; wirft das, steht die Meldung im Dialog, und die Eingabe bleibt.
 *
 * Geprüft wird auf dem Server (`inspectUpload`): ob der Schlüssel passt, was
 * das Zertifikat abdeckt, ob es gilt. Hier nur, ob überhaupt etwas dasteht.
 * Der Schlüssel bleibt im Zustand dieses Dialogs und geht mit dem Schließen.
 */

export interface UploadBody {
  certificate: string;
  privateKey: string;
  replace: string | null;
}

interface Props {
  /** Die Datei, die ersetzt wird. `null`: ein neues Zertifikat. */
  replace: { file: string; domains: string[] } | null;
  /** Was das Zertifikat abdecken soll, falls das feststeht (Assistent). */
  expected?: string[];
  onUpload: (body: UploadBody) => Promise<void>;
  onClose: () => void;
}

/** Größer ist keine Kette mehr, das prüft auch der Server. */
const MAX_FILE = 100_000;

export default function CertificateUploadDialog({ replace, expected, onUpload, onClose }: Props) {
  const { t } = useT();
  const [certificate, setCertificate] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const certFile = useRef<HTMLInputElement>(null);
  const keyFile = useRef<HTMLInputElement>(null);

  async function readFile(file: File | undefined, set: (text: string) => void) {
    if (!file) return;
    if (file.size > MAX_FILE) {
      setError(t('Die Datei ist größer als 100 KB. Ein Zertifikat mit Kette ist kleiner.'));
      return;
    }
    setError('');
    set(await file.text());
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!certificate.trim()) {
      setError(t('Bitte fügen Sie das Zertifikat ein.'));
      return;
    }
    setError('');
    setSaving(true);
    try {
      await onUpload({ certificate, privateKey, replace: replace?.file ?? null });
    } catch (err: unknown) {
      setError(err instanceof Error ? t(err.message) : t('Das Zertifikat ließ sich nicht hochladen.'));
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && !saving && onClose()}>
      <form className="modal" onSubmit={submit}>
        <div className="modal-header">
          <h2 className="modal-title">
            {replace ? t('Zertifikat ersetzen') : t('Zertifikat hochladen')}
            {replace && <span className="modal-subject">{replace.file}</span>}
          </h2>
          <button type="button" className="modal-close" onClick={onClose} disabled={saving} aria-label={t('Dialog schließen')}>
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          {expected && expected.length > 0 && (
            <p className="form-hint">{t('Es muss {domains} abdecken.', { domains: expected.join(', ') })}</p>
          )}
          {replace && replace.domains.length > 0 && (
            <p className="form-hint">
              {t('Bisher abgedeckt: {domains}. Was davon ein Ziel braucht, muss das neue auch abdecken.', {
                domains: replace.domains.join(', '),
              })}
            </p>
          )}

          <div className="form-group">
            <label className="form-label" htmlFor="upload-certificate">
              {t('Zertifikat mit Kette (PEM)')}
              <InfoHint
                text={t(
                  'Zuerst das Zertifikat der Domain, danach die Zwischenzertifikate. Eine fertige PEM-Datei für HAProxy mit dem Schlüssel darin geht auch, dann bleibt das Feld darunter leer.'
                )}
              />
            </label>
            <textarea
              id="upload-certificate"
              className="form-textarea mono"
              rows={6}
              value={certificate}
              onChange={(e) => setCertificate(e.target.value)}
              placeholder="-----BEGIN CERTIFICATE-----"
              disabled={saving}
              spellCheck={false}
              autoComplete="off"
            />
            <div className="hapm-form-actions">
              <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={() => certFile.current?.click()}>
                <FileUp size={14} />
                {t('Aus Datei laden')}
              </button>
            </div>
            <input
              ref={certFile}
              type="file"
              accept=".pem,.crt,.cer,.txt"
              hidden
              onChange={(e) => void readFile(e.target.files?.[0], setCertificate)}
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="upload-key">
              {t('Privater Schlüssel (PEM)')}
              <InfoHint
                text={t(
                  'Unverschlüsselt, HAProxy fragt beim Laden nach keinem Passwort. Er geht direkt in die Datei auf dem Server und wird in HAPM nicht gespeichert.'
                )}
              />
            </label>
            <textarea
              id="upload-key"
              className="form-textarea mono"
              rows={4}
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              placeholder="-----BEGIN PRIVATE KEY-----"
              disabled={saving}
              spellCheck={false}
              autoComplete="off"
            />
            <div className="hapm-form-actions">
              <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={() => keyFile.current?.click()}>
                <FileUp size={14} />
                {t('Aus Datei laden')}
              </button>
            </div>
            <input
              ref={keyFile}
              type="file"
              accept=".pem,.key,.txt"
              hidden
              onChange={(e) => void readFile(e.target.files?.[0], setPrivateKey)}
            />
          </div>

          {error && <div className="alert alert-danger">{error}</div>}
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
            {t('Abbrechen')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? <span className="btn-spinner" aria-hidden="true" /> : <Upload size={16} />}
            {replace ? t('Ersetzen') : t('Hochladen')}
          </button>
        </div>
      </form>
    </div>
  );
}
