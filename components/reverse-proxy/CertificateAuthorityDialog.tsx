'use client';

import { useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { FileUp, Upload, X } from 'lucide-react';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { errorText } from '@/components/errorText';
import { useT } from '@/lib/i18n/react';

/**
 * Eine Zertifizierungsstelle hinterlegen oder die Datei einer hinterlegten
 * austauschen.
 *
 * Geprüft wird auf dem Server (`inspectCaUpload`): lesbares PEM, kein privater
 * Schlüssel, nicht abgelaufen, ein Zertifikat, das als Vertrauensanker taugt.
 * Hier nur, ob überhaupt etwas dasteht. Der Dialog schickt nicht selbst: wirft
 * `onSave`, bleibt er mit der Eingabe offen, und die Meldung geht als Toast an
 * `onError`.
 */

export interface AuthorityBody {
  name: string;
  certificate: string;
  replace: boolean;
}

interface Props {
  /** Die Stelle, deren Datei ausgetauscht wird. `null`: eine neue. */
  replace: { name: string; usedBy: string[] } | null;
  onSave: (body: AuthorityBody) => Promise<void>;
  onError: (message: string) => void;
  onClose: () => void;
}

/** Größer ist kein Bündel mehr, das prüft auch der Server (`MAX_CA_INPUT`). */
const MAX_FILE = 300_000;

export default function CertificateAuthorityDialog({ replace, onSave, onError, onClose }: Props) {
  const { t } = useT();
  const [name, setName] = useState(replace?.name ?? '');
  const [certificate, setCertificate] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  async function readFile(input: HTMLInputElement) {
    const picked = input.files?.[0];
    // Sonst meldet der Browser keine Änderung, wenn dieselbe Datei noch einmal gewählt wird.
    input.value = '';
    if (!picked) return;
    if (picked.size > MAX_FILE) {
      setError(t('Die Datei ist größer als 300 KB. Eine Zertifizierungsstelle mit Zwischenstellen ist kleiner.'));
      return;
    }
    setError('');
    setCertificate(await picked.text());
    // Der Dateiname ist meist schon ein brauchbarer Name: `Intern Root CA.crt` wird `intern-root-ca`.
    if (!replace && !name.trim()) {
      const suggestion = picked.name
        .replace(/\.[A-Za-z0-9]+$/, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        .replace(/-+$/, '');
      if (suggestion) setName(suggestion);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError(t('Bitte geben Sie der Zertifizierungsstelle einen Namen.'));
      return;
    }
    if (!certificate.trim()) {
      setError(t('Bitte fügen Sie das Zertifikat der Zertifizierungsstelle ein.'));
      return;
    }
    setError('');
    setSaving(true);
    try {
      await onSave({ name: name.trim().toLowerCase(), certificate, replace: replace !== null });
    } catch (err: unknown) {
      onError(errorText(err, t('Die Zertifizierungsstelle ließ sich nicht hinterlegen.')));
      setSaving(false);
    }
  }

  return createPortal(
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && !saving && onClose()}>
      <form className="modal" onSubmit={submit}>
        <div className="modal-header">
          <h2 className="modal-title">
            {replace ? t('Zertifizierungsstelle ersetzen') : t('Zertifizierungsstelle hinterlegen')}
            {replace && <span className="modal-subject">{replace.name}</span>}
          </h2>
          <button type="button" className="modal-close" onClick={onClose} disabled={saving} aria-label={t('Dialog schließen')}>
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          {/* Die Folge steht sichtbar da: sie tritt mit dem Klick ein, nicht später. */}
          {replace && replace.usedBy.length > 0 && (
            <div className="alert alert-warning">
              {t(
                'HAProxy lädt danach neu. Ziele, deren Zertifikat die neue Datei nicht bestätigt, sind dann nicht mehr erreichbar (503): {list}.',
                { list: replace.usedBy.join(', ') }
              )}
            </div>
          )}

          {!replace && (
            <div className="form-group">
              <div className="form-label-row">
                <label className="form-label" htmlFor="authority-name">
                  {t('Name')}
                </label>
                <InfoHint
                  text={t(
                    'Unter diesem Namen wählen Sie die Stelle am Ziel aus. Kleinbuchstaben, Ziffern und Bindestriche, höchstens 40 Zeichen. Er wird zum Dateinamen, steht in haproxy.cfg und lässt sich danach nicht ändern.'
                  )}
                />
              </div>
              <input
                id="authority-name"
                className="form-input mono"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="intern-root"
                maxLength={40}
                disabled={saving}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
          )}

          <div className="form-group">
            <div className="form-label-row">
              <label className="form-label" htmlFor="authority-certificate">
                {t('Zertifikat der Zertifizierungsstelle (PEM)')}
              </label>
              <InfoHint
                text={t(
                  'Das Zertifikat der Stelle, die die Zertifikate Ihrer Ziele ausstellt. Stellt eine Zwischenstelle aus, fügen Sie Root und Zwischenstelle hintereinander ein. Kein privater Schlüssel: der gehört nicht auf diesen Server. Ein selbst signiertes Zertifikat eines Ziels geht auch, dann nimmt HAProxy genau dieses an.'
                )}
              />
            </div>
            <textarea
              id="authority-certificate"
              className="form-textarea mono"
              rows={8}
              value={certificate}
              onChange={(e) => setCertificate(e.target.value)}
              placeholder="-----BEGIN CERTIFICATE-----"
              disabled={saving}
              spellCheck={false}
              autoComplete="off"
            />
            <div className="hapm-form-actions">
              <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={() => file.current?.click()}>
                <FileUp size={14} />
                {t('Aus Datei laden')}
              </button>
            </div>
            <input ref={file} type="file" accept=".pem,.crt,.cer,.txt" hidden onChange={(e) => void readFile(e.target)} />
          </div>

          {error && <div className="alert alert-danger">{error}</div>}
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
            {t('Abbrechen')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? <span className="btn-spinner" aria-hidden="true" /> : <Upload size={16} />}
            {replace ? t('Ersetzen') : t('Hinterlegen')}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}
