'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { AlertTriangle, AtSign, Globe, Loader2, Plus, Save } from 'lucide-react';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { useConfirm } from '@/components/ConfirmDialog';
import { SkeletonDetail } from '@/components/Skeleton';
// Nur der Typ: die Datei dahinter erreicht `lib/db`.
import type { SettingsView } from '@/lib/settings';

interface SaveResult {
  settings: SettingsView;
  acme: { ok: boolean; detail: string } | null;
}

export default function GeneralSettingsPage() {
  const { apiFetch } = useApp();
  const { notify } = useToast();
  const confirm = useConfirm();

  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [error, setError] = useState('');
  /** Nur was getippt wurde. Ohne Eingabe zeigt das Feld den gespeicherten Wert. */
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const [urlError, setUrlError] = useState('');
  const [savingUrl, setSavingUrl] = useState(false);
  const [emailDraft, setEmailDraft] = useState<string | null>(null);
  const [emailError, setEmailError] = useState('');
  const [savingEmail, setSavingEmail] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/settings', { cache: 'no-store' });
      const body = await res.json();
      if (!body.success) throw new Error(body.error);
      setSettings(body.data as SettingsView);
      setError('');
    } catch {
      setError('Die Einstellungen konnten nicht geladen werden.');
    }
  }, [apiFetch]);

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
    if (!body.success) throw new Error(body.error || 'Die Einstellung ließ sich nicht speichern.');
    return body.data as SaveResult;
  }

  async function saveUrl(event: FormEvent) {
    event.preventDefault();
    if (!settings || urlDraft === null) return;
    setUrlError('');

    const next = urlDraft.trim();
    if (settings.publicUrl && next !== settings.publicUrl) {
      const confirmed = await confirm({
        title: next ? 'Adresse von HAPM ändern?' : 'Adresse von HAPM entfernen?',
        message:
          'Passkeys sind an die Domain gebunden. Mit den bisher hinterlegten ist danach keine Anmeldung mehr möglich. Links in schon verschickten Mails zeigen weiter auf die alte Adresse.',
        confirmLabel: next ? 'Adresse ändern' : 'Adresse entfernen',
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
          ? `HAPM gilt als erreichbar unter ${result.settings.publicUrl}.`
          : 'Die Adresse ist entfernt. Mails enthalten keinen Link in die Oberfläche.',
      });
    } catch (err: unknown) {
      setUrlError(err instanceof Error ? err.message : 'Die Adresse ließ sich nicht speichern.');
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
          title: 'Gespeichert, aber nicht bei acme.sh angekommen',
          message: result.acme.detail,
        });
      } else {
        notify({ variant: 'success', message: 'Die Adresse für Let\'s Encrypt ist gespeichert.' });
      }
    } catch (err: unknown) {
      setEmailError(err instanceof Error ? err.message : 'Die Adresse ließ sich nicht speichern.');
    } finally {
      setSavingEmail(false);
    }
  }

  const header = (
    <div className="page-header">
      <div>
        <h1 className="page-title">Allgemein</h1>
        <p className="page-subtitle">Die Adresse von HAPM und der Kontakt bei Let&apos;s Encrypt.</p>
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
  const target = settings.listenPort ? `127.0.0.1:${settings.listenPort}` : '127.0.0.1 und den Port von HAPM';

  return (
    <>
      {header}

      {error && <div className="alert alert-danger sys-block">{error}</div>}

      <div className="card sys-block">
        <div className="card-header">
          <div>
            <h2 className="card-title">
              <Globe size={17} strokeWidth={1.5} />
              Adresse von HAPM
            </h2>
            <p className="card-subtitle">Sie steht in den Links der Mails, und an ihre Domain werden Passkeys gebunden.</p>
          </div>
          <span className={`badge-status ${settings.publicUrl ? 'badge-success' : 'badge-neutral'}`}>
            <span className="dot" />
            {settings.publicUrl ? 'Eingerichtet' : 'Nicht eingerichtet'}
          </span>
        </div>

        <form className="card-body" onSubmit={saveUrl}>
          {urlError && <div className="alert alert-danger">{urlError}</div>}

          <div className="form-group">
            <label className="form-label" htmlFor="public-url">
              Adresse
              <InfoHint
                text={`HAPM ist unter der Domain erst erreichbar, wenn sie im Reverse-Proxy als Ziel angelegt ist und auf ${target} zeigt. Dabei entsteht auch ihr Zertifikat. Die Adresse hier anzugeben richtet das nicht ein.`}
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
            <p className="form-hint">Nur https:// und die Domain, ohne Pfad dahinter.</p>
          </div>

          <div className="alert alert-warning">
            <AlertTriangle size={16} strokeWidth={1.5} />
            <span>Eine spätere Änderung der Domain entwertet alle hinterlegten Passkeys.</span>
          </div>

          <div className="hapm-form-actions">
            <button className="btn btn-primary" type="submit" disabled={savingUrl || !urlChanged}>
              {savingUrl ? <Loader2 size={16} strokeWidth={1.5} className="spin" /> : <Save size={16} strokeWidth={1.5} />}
              Speichern
            </button>
            <Link className="btn btn-secondary" href="/reverse-proxy">
              <Plus size={16} strokeWidth={1.5} />
              Ziel anlegen
            </Link>
          </div>
        </form>
      </div>

      <div className="card sys-block">
        <div className="card-header">
          <div>
            <h2 className="card-title">
              <AtSign size={17} strokeWidth={1.5} />
              E-Mail für Let&apos;s Encrypt
            </h2>
            <p className="card-subtitle">Mit dieser Adresse meldet acme.sh das Konto bei Let&apos;s Encrypt an.</p>
          </div>
        </div>

        <form className="card-body" onSubmit={saveEmail}>
          {emailError && <div className="alert alert-danger">{emailError}</div>}

          <div className="form-group">
            <label className="form-label" htmlFor="acme-email">
              E-Mail-Adresse
              <InfoHint text="Let's Encrypt verschickt keine Warnungen vor dem Ablauf eines Zertifikats mehr. Wer gewarnt werden will, richtet die Benachrichtigungen von HAPM ein." />
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
              Speichern
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
