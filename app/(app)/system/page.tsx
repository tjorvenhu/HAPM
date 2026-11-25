'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { AlertTriangle, AtSign, Globe, Home, Loader2, Network, Plus, Save } from 'lucide-react';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { useConfirm } from '@/components/ConfirmDialog';
import { SkeletonDetail } from '@/components/Skeleton';
import CertificateSourceCard from '@/components/system/CertificateSourceCard';
import { msgid } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';
// Nur der Typ: die Datei dahinter erreicht `lib/db`.
import type { SettingsView } from '@/lib/settings';
import type { Exposure } from '@/lib/types';

/** Dieselben zwei Möglichkeiten wie im Assistenten, mit der Folge für künftige Zertifikate. */
const EXPOSURE_CHOICES: { value: Exposure; title: string; text: string }[] = [
  {
    value: 'internal',
    title: msgid('Nur im eigenen Netz'),
    text: msgid("Let's Encrypt erreicht den Server nicht. Neue Zertifikate gehen über den DNS-Anbieter, über einen eigenen ACME-Server, der HAPM über Port 80 erreicht, oder werden hochgeladen."),
  },
  {
    value: 'public',
    title: msgid('Aus dem Internet erreichbar'),
    text: msgid("Neue Zertifikate prüft Let's Encrypt über Port 80. Der DNS-Anbieter wird nur für Wildcards gebraucht."),
  },
];

interface SaveResult {
  settings: SettingsView;
  acme: { ok: boolean; detail: string } | null;
}

export default function GeneralSettingsPage() {
  const { apiFetch } = useApp();
  const { notify } = useToast();
  const confirm = useConfirm();
  const { t } = useT();

  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [error, setError] = useState('');
  /** Nur was getippt wurde. Ohne Eingabe zeigt das Feld den gespeicherten Wert. */
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const [urlError, setUrlError] = useState('');
  const [savingUrl, setSavingUrl] = useState(false);
  const [emailDraft, setEmailDraft] = useState<string | null>(null);
  const [emailError, setEmailError] = useState('');
  const [savingEmail, setSavingEmail] = useState(false);
  const [savingExposure, setSavingExposure] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/settings', { cache: 'no-store' });
      const body = await res.json();
      if (!body.success) throw new Error(body.error);
      setSettings(body.data as SettingsView);
      setError('');
    } catch {
      setError(t('Die Einstellungen konnten nicht geladen werden.'));
    }
  }, [apiFetch, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function patch(payload: Record<string, unknown>): Promise<SaveResult> {
    const res = await apiFetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    if (!body.success) throw new Error(body.error || t('Die Einstellung ließ sich nicht speichern.'));
    return body.data as SaveResult;
  }

  async function saveUrl(event: FormEvent) {
    event.preventDefault();
    if (!settings || urlDraft === null) return;
    setUrlError('');

    const next = urlDraft.trim();
    if (settings.publicUrl && next !== settings.publicUrl) {
      const confirmed = await confirm({
        title: next ? t('Adresse von HAPM ändern?') : t('Adresse von HAPM entfernen?'),
        message: t(
          'Passkeys sind an die Domain gebunden. Mit den bisher hinterlegten ist danach keine Anmeldung mehr möglich. Links in schon verschickten Mails zeigen weiter auf die alte Adresse. Das Ziel, über das die bisherige Adresse läuft, lässt sich danach wieder entfernen: geschützt ist immer das Ziel der aktuellen Adresse.'
        ),
        confirmLabel: next ? t('Adresse ändern') : t('Adresse entfernen'),
        variant: 'danger',
      });
      if (!confirmed) return;
    }

    setSavingUrl(true);
    try {
      const result = await patch({ publicUrl: next || null });
      setSettings(result.settings);
      setUrlDraft(null);
      notify({
        variant: 'success',
        message: result.settings.publicUrl
          ? t('HAPM gilt als erreichbar unter {url}.', { url: result.settings.publicUrl })
          : t('Die Adresse ist entfernt. Mails enthalten keinen Link in die Oberfläche.'),
      });
    } catch (err: unknown) {
      setUrlError(err instanceof Error ? err.message : t('Die Adresse ließ sich nicht speichern.'));
    } finally {
      setSavingUrl(false);
    }
  }

  async function saveEmail(event: FormEvent) {
    event.preventDefault();
    if (!settings || emailDraft === null) return;
    setEmailError('');
    setSavingEmail(true);
    try {
      const result = await patch({ acmeEmail: emailDraft.trim() || null });
      setSettings(result.settings);
      setEmailDraft(null);
      if (result.acme && !result.acme.ok) {
        notify({
          variant: 'warning',
          title: t('Gespeichert, aber nicht bei acme.sh angekommen'),
          message: result.acme.detail,
        });
      } else {
        notify({ variant: 'success', message: t("Die Adresse für Let's Encrypt ist gespeichert.") });
      }
    } catch (err: unknown) {
      setEmailError(err instanceof Error ? err.message : t('Die Adresse ließ sich nicht speichern.'));
    } finally {
      setSavingEmail(false);
    }
  }

  async function saveExposure(next: Exposure) {
    if (!settings || next === settings.exposure) return;
    const confirmed = await confirm({
      title:
        next === 'internal'
          ? t('Auf „Nur im eigenen Netz" umstellen?')
          : t('Auf „Aus dem Internet erreichbar" umstellen?'),
      message:
        next === 'internal'
          ? t(
              'Jedes neue Zertifikat wird danach über den DNS-Anbieter ausgestellt, außer ein eigener ACME-Server erreicht HAPM über Port 80 oder Zertifikate werden hochgeladen. Ohne einen dieser Wege lässt sich kein Ziel mehr anlegen. Bestehende Zertifikate behalten ihre Methode, auch bei der Erneuerung.'
            )
          : t(
              "Neue Zertifikate werden danach über Port 80 geprüft. Erreicht Let's Encrypt den Server nicht, scheitert jeder neue Antrag. Bestehende Zertifikate behalten ihre Methode, auch bei der Erneuerung."
            ),
      confirmLabel: t('Umstellen'),
    });
    if (!confirmed) return;

    setSavingExposure(true);
    try {
      const result = await patch({ exposure: next });
      setSettings(result.settings);
      notify({ variant: 'success', message: t('Die Art der Installation ist umgestellt. Sie gilt für neue Zertifikate.') });
    } catch (err: unknown) {
      notify({
        variant: 'error',
        message: err instanceof Error ? err.message : t('Die Einstellung ließ sich nicht speichern.'),
      });
    } finally {
      setSavingExposure(false);
    }
  }

  const header = (
    <div className="page-header">
      <div>
        <h1 className="page-title">{t('Allgemein')}</h1>
        <p className="page-subtitle">{t('Adresse, Art der Installation, Zertifikate und der Kontakt beim ACME-Server.')}</p>
      </div>
    </div>
  );

  if (!settings) {
    return (
      <>
        {header}
        {error ? <div className="alert alert-danger sys-block">{error}</div> : <SkeletonDetail />}
      </>
    );
  }

  const urlValue = urlDraft ?? settings.publicUrl ?? '';
  const urlChanged = urlDraft !== null && urlDraft.trim() !== (settings.publicUrl ?? '');
  const emailValue = emailDraft ?? settings.acmeEmail ?? '';
  const emailChanged = emailDraft !== null && emailDraft.trim() !== (settings.acmeEmail ?? '');
  const target = settings.listenPort ? `127.0.0.1:${settings.listenPort}` : t('127.0.0.1 und den Port von HAPM');

  return (
    <>
      {header}

      {error && <div className="alert alert-danger sys-block">{error}</div>}

      <div className="card sys-block">
        <div className="card-header">
          <div>
            <h2 className="card-title">
              <Globe size={17} strokeWidth={1.5} />
              {t('Adresse von HAPM')}
            </h2>
            <p className="card-subtitle">{t('Sie steht in den Links der Mails, und an ihre Domain werden Passkeys gebunden.')}</p>
          </div>
          <span className={`badge-status ${settings.publicUrl ? 'badge-success' : 'badge-neutral'}`}>
            <span className="dot" />
            {settings.publicUrl ? t('Eingerichtet') : t('Nicht eingerichtet')}
          </span>
        </div>

        <form className="card-body" onSubmit={saveUrl}>
          {urlError && <div className="alert alert-danger">{urlError}</div>}

          <div className="form-group">
            <label className="form-label" htmlFor="public-url">
              {t('Adresse')}
              <InfoHint
                text={t(
                  'HAPM ist unter der Domain erst erreichbar, wenn sie im Reverse-Proxy als Ziel angelegt ist und auf {target} zeigt. Dabei entsteht auch ihr Zertifikat. Die Adresse hier anzugeben richtet das nicht ein.',
                  { target }
                )}
              />
            </label>
            <input
              id="public-url"
              className="form-input"
              type="url"
              inputMode="url"
              placeholder="https://hapm.example.org"
              value={urlValue}
              disabled={savingUrl}
              onChange={(event) => setUrlDraft(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="form-hint">{t('Nur https:// und die Domain, ohne Pfad dahinter.')}</p>
          </div>

          <div className="alert alert-warning">
            <AlertTriangle size={16} strokeWidth={1.5} />
            <span>{t('Eine spätere Änderung der Domain entwertet alle hinterlegten Passkeys.')}</span>
          </div>

          <div className="hapm-form-actions">
            <button className="btn btn-primary" type="submit" disabled={savingUrl || !urlChanged}>
              {savingUrl ? <Loader2 size={16} strokeWidth={1.5} className="spin" /> : <Save size={16} strokeWidth={1.5} />}
              {t('Speichern')}
            </button>
            <Link className="btn btn-secondary" href="/reverse-proxy">
              <Plus size={16} strokeWidth={1.5} />
              {t('Ziel anlegen')}
            </Link>
          </div>
        </form>
      </div>

      <div className="card sys-block">
        <div className="card-header">
          <div>
            <h2 className="card-title">
              <Network size={17} strokeWidth={1.5} />
              {t('Art der Installation')}
            </h2>
            <p className="card-subtitle">{t('Sie bestimmt, wie neue Zertifikate ausgestellt werden.')}</p>
          </div>
        </div>

        <div className="card-body">
          <div className="hapm-choices">
            {EXPOSURE_CHOICES.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`hapm-choice${settings.exposure === option.value ? ' is-selected' : ''}`}
                aria-pressed={settings.exposure === option.value}
                disabled={savingExposure}
                onClick={() => void saveExposure(option.value)}
              >
                {option.value === 'internal' ? <Home size={18} strokeWidth={1.5} /> : <Globe size={18} strokeWidth={1.5} />}
                <span className="hapm-choice-text">
                  <strong>{t(option.title)}</strong>
                  <span>{t(option.text)}</span>
                </span>
              </button>
            ))}
          </div>

          <div className="alert alert-info">
            <span>{t('Bestehende Zertifikate behalten ihre Methode, auch bei der Erneuerung.')}</span>
          </div>
        </div>
      </div>

      <CertificateSourceCard settings={settings} onSaved={setSettings} />

      <div className="card sys-block">
        <div className="card-header">
          <div>
            <h2 className="card-title">
              <AtSign size={17} strokeWidth={1.5} />
              {t("E-Mail für Let's Encrypt")}
            </h2>
            <p className="card-subtitle">{t("Mit dieser Adresse meldet acme.sh das Konto bei Let's Encrypt an.")}</p>
          </div>
        </div>

        <form className="card-body" onSubmit={saveEmail}>
          {emailError && <div className="alert alert-danger">{emailError}</div>}

          <div className="form-group">
            <label className="form-label" htmlFor="acme-email">
              {t('E-Mail-Adresse')}
              <InfoHint
                text={t(
                  "Let's Encrypt verschickt keine Warnungen vor dem Ablauf eines Zertifikats mehr. Wer gewarnt werden will, richtet die Benachrichtigungen von HAPM ein."
                )}
              />
            </label>
            <input
              id="acme-email"
              className="form-input"
              type="email"
              placeholder="admin@example.org"
              value={emailValue}
              disabled={savingEmail}
              onChange={(event) => setEmailDraft(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div className="hapm-form-actions">
            <button className="btn btn-primary" type="submit" disabled={savingEmail || !emailChanged}>
              {savingEmail ? <Loader2 size={16} strokeWidth={1.5} className="spin" /> : <Save size={16} strokeWidth={1.5} />}
              {t('Speichern')}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
