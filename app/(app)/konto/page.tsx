'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Fingerprint, KeyRound, Languages, Loader2, Pencil, Plus, ShieldCheck, ShieldOff, Trash2, X } from 'lucide-react';
import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import { useApp } from '@/components/AppShell';
import { useConfirm } from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import { usePolling } from '@/components/usePolling';
import { SkeletonRows } from '@/components/Skeleton';
import TwoFactorSetup from '@/components/TwoFactorSetup';
import Select from '@/components/Select';
import { formatDate, LOCALES, LOCALE_NAMES, msgid, type Locale } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';
import {
  MAX_PASSKEYS_PER_USER,
  PASSKEY_NAME_MAX,
  passkeyBrowserError,
  suggestPasskeyName,
  type PasskeyRequirement,
} from '@/lib/auth/passkey-rules';
// Nur die Typen: die Dateien dahinter erreichen den Anmeldedienst und damit `lib/db`.
import type { PublicUser } from '@/lib/auth/users';
import type { PasskeyView } from '@/lib/auth/passkeys';

type RegistrationOptions = Parameters<typeof startRegistration>[0]['optionsJSON'];

/** Was der Dialog gerade tut: einen Passkey hinterlegen oder einen umbenennen. */
type PasskeyDialog = { mode: 'add' } | { mode: 'rename'; passkey: PasskeyView };

interface PasskeyState {
  available: boolean;
  missing: PasskeyRequirement[];
  passkeys: PasskeyView[];
  max: number;
}

/** Was fehlt, wo es eingerichtet wird und wozu Passkeys es brauchen. */
const REQUIREMENTS: Record<PasskeyRequirement, { label: string; href: string; reason: string }> = {
  publicUrl: {
    label: msgid('Adresse von HAPM'),
    href: '/system',
    reason: msgid('An ihrer Domain hängt jeder Passkey.'),
  },
  mail: {
    label: msgid('SMTP-Konto'),
    href: '/notifications',
    reason: msgid('HAPM meldet per Mail, wenn an Ihrem Konto ein Passkey dazukommt oder wegfällt.'),
  },
};

/**
 * Das eigene Konto: wie man sich daran anmeldet. Ein Passkey kommt zu Passwort
 * und zweitem Faktor dazu und ersetzt keines von beiden.
 */
export default function AccountPage() {
  const { apiFetch, session, reload } = useApp();
  const confirm = useConfirm();
  const { notify } = useToast();
  const { t, rich, locale, setLocale } = useT();

  const [account, setAccount] = useState<PublicUser | null>(null);
  const [passkeyState, setPasskeyState] = useState<PasskeyState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  const [setupOpen, setSetupOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [disablePassword, setDisablePassword] = useState('');
  const [disableError, setDisableError] = useState('');
  const [disabling, setDisabling] = useState(false);

  const [savingLocale, setSavingLocale] = useState(false);

  const [passkeyDialog, setPasskeyDialog] = useState<PasskeyDialog | null>(null);
  const [passkeyName, setPasskeyName] = useState('');
  const [passkeyError, setPasskeyError] = useState('');
  const [savingPasskey, setSavingPasskey] = useState(false);

  const load = useCallback(async () => {
    try {
      const [accountRes, passkeyRes] = await Promise.all([apiFetch('/api/account'), apiFetch('/api/account/passkeys')]);
      const [accountData, passkeyData] = await Promise.all([accountRes.json(), passkeyRes.json()]);
      if (!accountRes.ok) throw new Error(accountData.error);
      if (!passkeyRes.ok) throw new Error(passkeyData.error);
      setAccount(accountData.data);
      setPasskeyState(passkeyData.data);
      setError('');
    } catch {
      setError(t('Das Konto konnte nicht geladen werden.'));
    } finally {
      setLoading(false);
    }
  }, [apiFetch, t]);

  useEffect(() => {
    load();
  }, [load]);

  // Ein Passkey kann in einem anderen Fenster dazukommen, und die Voraussetzungen
  // (Adresse, SMTP-Konto) richtet jemand auf einer anderen Seite ein.
  usePolling(load, 30_000);

  async function handlePassword(e: FormEvent) {
    e.preventDefault();
    setPasswordError('');
    if (next !== repeat) {
      setPasswordError(t('Die neuen Passwörter stimmen nicht überein.'));
      return;
    }

    setSavingPassword(true);
    try {
      const res = await apiFetch('/api/account/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current, next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('Das Passwort ließ sich nicht ändern.'));

      setCurrent('');
      setNext('');
      setRepeat('');
      notify({
        variant: 'success',
        message: t('Das Passwort ist geändert. Alle anderen Sitzungen dieses Kontos sind beendet.'),
      });
    } catch (err: unknown) {
      setPasswordError(err instanceof Error ? err.message : t('Das Passwort ließ sich nicht ändern.'));
    } finally {
      setSavingPassword(false);
    }
  }

  async function handleSetupComplete() {
    setSetupOpen(false);
    await load();
    notify({
      variant: 'success',
      message: t('Der zweite Faktor ist eingerichtet. Alle anderen Sitzungen dieses Kontos sind beendet.'),
    });
  }

  function openDisable() {
    setDisablePassword('');
    setDisableError('');
    setDisableOpen(true);
  }

  async function handleDisable(e: FormEvent) {
    e.preventDefault();
    setDisableError('');
    setDisabling(true);
    try {
      const res = await apiFetch('/api/account/2fa', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: disablePassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('Der zweite Faktor ließ sich nicht abschalten.'));

      await load();
      setDisableOpen(false);
      notify({ variant: 'success', message: t('Der zweite Faktor ist abgeschaltet.') });
    } catch (err: unknown) {
      setDisableError(err instanceof Error ? err.message : t('Der zweite Faktor ließ sich nicht abschalten.'));
    } finally {
      setDisabling(false);
    }
  }

  function openAddPasskey() {
    setPasskeyName(t(suggestPasskeyName(navigator.userAgent)));
    setPasskeyError('');
    setPasskeyDialog({ mode: 'add' });
  }

  function openRenamePasskey(passkey: PasskeyView) {
    setPasskeyName(passkey.name);
    setPasskeyError('');
    setPasskeyDialog({ mode: 'rename', passkey });
  }

  /** Aufgabe holen, das Gerät fragen, die Antwort prüfen lassen. */
  async function addPasskey() {
    if (!browserSupportsWebAuthn()) throw new Error(t('Dieser Browser unterstützt keine Passkeys.'));

    const prepared = await apiFetch('/api/account/passkeys/options', { method: 'POST' });
    const challenge = await prepared.json();
    if (!prepared.ok || !challenge.data?.options) {
      throw new Error(challenge.error || t('Der Passkey kann gerade nicht hinterlegt werden.'));
    }

    let attestation;
    try {
      attestation = await startRegistration({ optionsJSON: challenge.data.options as RegistrationOptions });
    } catch (err) {
      throw new Error(t(passkeyBrowserError((err as { name?: string } | null)?.name, 'register')));
    }

    const res = await apiFetch('/api/account/passkeys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: attestation, name: passkeyName }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || t('Der Passkey konnte nicht hinterlegt werden.'));
  }

  async function renamePasskey(passkey: PasskeyView) {
    const res = await apiFetch(`/api/account/passkeys/${encodeURIComponent(passkey.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: passkeyName }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || t('Der Name konnte nicht gespeichert werden.'));
  }

  async function handlePasskeySubmit(e: FormEvent) {
    e.preventDefault();
    if (!passkeyDialog) return;
    setPasskeyError('');
    setSavingPasskey(true);
    try {
      if (passkeyDialog.mode === 'add') await addPasskey();
      else await renamePasskey(passkeyDialog.passkey);

      // Erst nachladen, dann melden: die Meldung meint auch, dass die Liste es zeigt.
      await load();
      setPasskeyDialog(null);
      notify({
        variant: 'success',
        message:
          passkeyDialog.mode === 'add'
            ? t('Der Passkey ist hinterlegt. Bei der nächsten Anmeldung können Sie ihn benutzen.')
            : t('Der Name ist gespeichert.'),
      });
    } catch (err: unknown) {
      setPasskeyError(err instanceof Error ? err.message : t('Der Vorgang ist fehlgeschlagen.'));
    } finally {
      setSavingPasskey(false);
    }
  }

  async function handleRemovePasskey(passkey: PasskeyView) {
    await confirm({
      title: t('Passkey entfernen'),
      message: t(
        'Mit "{name}" ist danach keine Anmeldung mehr möglich. Ihr Passwort bleibt bestehen. Auf dem Gerät selbst löschen Sie den Passkey in dessen Einstellungen.',
        { name: passkey.name }
      ),
      confirmLabel: t('Entfernen'),
      variant: 'danger',
      onConfirm: async () => {
        const res = await apiFetch(`/api/account/passkeys/${encodeURIComponent(passkey.id)}`, {
          method: 'DELETE',
        });
        const data = await res.json();
        if (!res.ok) {
          notify({ variant: 'error', message: data.error || t('Der Passkey ließ sich nicht entfernen.') });
          throw new Error(data.error);
        }
        await load();
        notify({ variant: 'success', message: t('Der Passkey ist entfernt.') });
      },
    });
  }

  /**
   * Erst speichern, dann umschalten. `reload()` holt die Sitzung mit der neuen
   * Sprache, sonst stellte `AppShell` auf die alte zurück.
   */
  async function handleLocale(next: Locale) {
    if (next === locale) return;
    setSavingLocale(true);
    try {
      const res = await apiFetch('/api/account/locale', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('Die Sprache ließ sich nicht speichern.'));
      await reload();
      setLocale(next);
    } catch (err: unknown) {
      notify({
        variant: 'error',
        message: err instanceof Error ? err.message : t('Die Sprache ließ sich nicht speichern.'),
      });
    } finally {
      setSavingLocale(false);
    }
  }

  const passkeys = passkeyState?.passkeys ?? [];
  const maxPasskeys = passkeyState?.max ?? MAX_PASSKEYS_PER_USER;
  const passkeysBlocked = passkeyState !== null && !passkeyState.available;
  const passkeysFull = passkeys.length >= maxPasskeys;

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('Konto')}</h1>
          <p className="page-subtitle">
            {t('Angemeldet als {name} ({email}).', { name: session.name, email: session.email })}
          </p>
        </div>
      </div>

      {error && <div className="alert alert-danger sys-block">{error}</div>}

      <div className="card sys-block">
        <div className="card-header">
          <div>
            <h2 className="card-title">
              <Languages size={17} />
              {t('Sprache')}
            </h2>
            <p className="card-subtitle">{t('Gilt für dieses Konto, auf jedem Gerät.')}</p>
          </div>
        </div>
        <div className="card-body">
          <div className="form-group hapm-locale-field">
            <label className="form-label" htmlFor="accountLocale">
              {t('Sprache der Oberfläche')}
            </label>
            <Select<Locale>
              id="accountLocale"
              value={locale}
              onChange={handleLocale}
              disabled={savingLocale}
              options={LOCALES.map((option) => ({ value: option, label: LOCALE_NAMES[option] }))}
            />
          </div>
        </div>
      </div>

      <div className="card sys-block">
        <div className="card-header">
          <div>
            <h2 className="card-title">
              <KeyRound size={17} />
              {t('Passwort ändern')}
            </h2>
            <p className="card-subtitle">{t('Mindestens 10 Zeichen mit Groß- und Kleinbuchstaben und einer Zahl.')}</p>
          </div>
        </div>

        <form className="card-body" onSubmit={handlePassword}>
          {passwordError && <div className="alert alert-danger">{passwordError}</div>}

          <div className="form-group">
            <label className="form-label" htmlFor="currentPassword">{t('Aktuelles Passwort')}</label>
            <input
              id="currentPassword"
              className="form-input"
              type="password"
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label" htmlFor="nextPassword">{t('Neues Passwort')}</label>
              <input
                id="nextPassword"
                className="form-input"
                type="password"
                required
                minLength={10}
                value={next}
                onChange={(e) => setNext(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="repeatPassword">{t('Neues Passwort wiederholen')}</label>
              <input
                id="repeatPassword"
                className="form-input"
                type="password"
                required
                minLength={10}
                value={repeat}
                onChange={(e) => setRepeat(e.target.value)}
                autoComplete="new-password"
              />
            </div>
          </div>

          <p className="form-hint">{t('Alle anderen Sitzungen dieses Kontos werden dabei beendet.')}</p>

          <div>
            <button className="btn btn-primary" type="submit" disabled={savingPassword}>
              {savingPassword ? <Loader2 size={16} className="spin" /> : <KeyRound size={16} />}
              {t('Passwort ändern')}
            </button>
          </div>
        </form>
      </div>

      <div className="card sys-block">
        <div className="card-header">
          <div>
            <h2 className="card-title">
              <ShieldCheck size={17} />
              {t('Zweiter Faktor')}
            </h2>
            <p className="card-subtitle">{t('Nach dem Passwort verlangt die Anmeldung einen Code aus einer App.')}</p>
          </div>
          {account && (
            <span className={`badge-status ${account.totpEnabled ? 'badge-success' : 'badge-neutral'}`}>
              <span className="dot" />
              {account.totpEnabled ? t('Eingerichtet') : t('Nicht eingerichtet')}
            </span>
          )}
        </div>

        {loading ? (
          <SkeletonRows />
        ) : account ? (
          <div className="card-body">
            <div className="alert alert-warning">
              <span>
                {rich(
                  'Es gibt keine Wiederherstellungscodes. Geht die Authenticator-App verloren, hilft nur noch der Zugang zum Server: dort setzt {command} mit der E-Mail-Adresse dahinter ein neues Passwort, schaltet den zweiten Faktor ab und entfernt die Passkeys.',
                  { command: <code>docker exec -it hapm hapm-admin reset-password</code> }
                )}
              </span>
            </div>
            <div>
              {account.totpEnabled ? (
                <button className="btn btn-secondary" type="button" onClick={openDisable}>
                  <ShieldOff size={16} />
                  {t('Abschalten')}
                </button>
              ) : (
                <button className="btn btn-primary" type="button" onClick={() => setSetupOpen(true)}>
                  <ShieldCheck size={16} />
                  {t('Einrichten')}
                </button>
              )}
            </div>
          </div>
        ) : null}
      </div>

      <div className={`card sys-block${passkeysBlocked ? ' hapm-card-blocked' : ''}`}>
        <div className="card-header">
          <div>
            <h2 className="card-title">
              <Fingerprint size={17} />
              {t('Passkeys')}
            </h2>
            <p className="card-subtitle">
              {t('Anmelden ohne Passwort und ohne Code, per Fingerabdruck, Gesicht oder PIN.')}
            </p>
          </div>
          <button
            className="btn btn-primary"
            type="button"
            onClick={openAddPasskey}
            disabled={loading || !passkeyState?.available || passkeysFull}
            data-tooltip={
              passkeysBlocked
                ? t('Erst einrichten, was unten steht')
                : passkeysFull
                  ? t('Mehr als {max} Passkeys je Konto sind nicht möglich', { max: maxPasskeys })
                  : undefined
            }
            data-tooltip-pos="left"
          >
            <Plus size={16} />
            {t('Passkey hinzufügen')}
          </button>
        </div>

        {loading ? (
          <SkeletonRows />
        ) : passkeyState && !passkeyState.available ? (
          <div className="card-body">
            <p>{t('Passkeys lassen sich erst benutzen, wenn das eingerichtet ist:')}</p>
            <ul className="hapm-requirements">
              {passkeyState.missing.map((item) => (
                <li key={item}>
                  <Link href={REQUIREMENTS[item].href}>{t(REQUIREMENTS[item].label)}</Link>
                  <span>{t(REQUIREMENTS[item].reason)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : passkeyState && passkeys.length === 0 ? (
          <div className="card-body">
            <p className="form-hint">
              {t(
                'Noch kein Passkey hinterlegt. Ein Passkey liegt auf Ihrem Gerät oder in Ihrem Passwortmanager. Geht das Gerät verloren, melden Sie sich wie bisher mit dem Passwort an.'
              )}
            </p>
          </div>
        ) : passkeyState ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('Name')}</th>
                  <th>{t('Ablage')}</th>
                  <th>{t('Hinterlegt am')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {passkeys.map((passkey) => (
                  <tr key={passkey.id}>
                    <td>{passkey.name}</td>
                    <td>{t(passkey.storage)}</td>
                    <td>{formatDate(locale, passkey.createdAt)}</td>
                    <td>
                      <div className="actions" style={{ justifyContent: 'flex-end' }}>
                        <button
                          className="btn btn-ghost btn-icon btn-sm"
                          type="button"
                          data-tooltip={t('Umbenennen')}
                          data-tooltip-pos="left"
                          aria-label={t('{name} umbenennen', { name: passkey.name })}
                          onClick={() => openRenamePasskey(passkey)}
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          className="btn btn-ghost btn-icon btn-sm"
                          type="button"
                          data-tooltip={t('Entfernen')}
                          data-tooltip-pos="left"
                          aria-label={t('{name} entfernen', { name: passkey.name })}
                          onClick={() => handleRemovePasskey(passkey)}
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
        ) : null}
      </div>

      {setupOpen && (
        <TwoFactorSetup onComplete={handleSetupComplete} onCancel={() => setSetupOpen(false)} />
      )}

      {disableOpen && (
        <div
          className="modal-overlay"
          onClick={(e) => e.target === e.currentTarget && !disabling && setDisableOpen(false)}
        >
          <div className="modal">
            <div className="modal-header">
              <h2 className="modal-title">{t('Zweiten Faktor abschalten')}</h2>
              <button
                type="button"
                className="modal-close"
                onClick={() => setDisableOpen(false)}
                disabled={disabling}
                aria-label={t('Dialog schließen')}
              >
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleDisable}>
              <div className="modal-body">
                {disableError && <div className="alert alert-danger">{disableError}</div>}
                <p className="form-hint">
                  {t('Danach reicht für die Anmeldung das Passwort. Das hinterlegte Geheimnis wird gelöscht.')}
                </p>
                <div className="form-group">
                  <label className="form-label" htmlFor="disablePassword">{t('Passwort')}</label>
                  <input
                    id="disablePassword"
                    className="form-input"
                    type="password"
                    required
                    value={disablePassword}
                    onChange={(e) => setDisablePassword(e.target.value)}
                    autoComplete="current-password"
                    autoFocus
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setDisableOpen(false)}
                  disabled={disabling}
                >
                  {t('Abbrechen')}
                </button>
                <button className="btn btn-danger" type="submit" disabled={disabling}>
                  {disabling ? <Loader2 size={16} className="spin" /> : <ShieldOff size={16} />}
                  {t('Abschalten')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {passkeyDialog && (
        <div
          className="modal-overlay"
          onClick={(e) => e.target === e.currentTarget && !savingPasskey && setPasskeyDialog(null)}
        >
          <div className="modal">
            <div className="modal-header">
              <h2 className="modal-title">
                {passkeyDialog.mode === 'add' ? t('Passkey hinzufügen') : t('Passkey umbenennen')}
              </h2>
              <button
                type="button"
                className="modal-close"
                onClick={() => setPasskeyDialog(null)}
                disabled={savingPasskey}
                aria-label={t('Dialog schließen')}
              >
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handlePasskeySubmit}>
              <div className="modal-body">
                {passkeyError && <div className="alert alert-danger">{passkeyError}</div>}

                <div className="form-group">
                  <label className="form-label" htmlFor="passkeyName">{t('Name')}</label>
                  <input
                    id="passkeyName"
                    className="form-input"
                    required
                    maxLength={PASSKEY_NAME_MAX}
                    value={passkeyName}
                    onChange={(e) => setPasskeyName(e.target.value)}
                    placeholder={t('z. B. MacBook oder iPhone')}
                    autoFocus
                  />
                  <p className="form-hint">
                    {passkeyDialog.mode === 'add'
                      ? t('Ihr Gerät fragt gleich nach Fingerabdruck, Gesicht oder PIN.')
                      : t('Der Name steht nur in dieser Liste. Auf dem Gerät ändert sich nichts.')}
                  </p>
                </div>
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setPasskeyDialog(null)}
                  disabled={savingPasskey}
                >
                  {t('Abbrechen')}
                </button>
                <button className="btn btn-primary" type="submit" disabled={savingPasskey}>
                  {savingPasskey ? <Loader2 size={16} className="spin" /> : null}
                  {passkeyDialog.mode === 'add' ? t('Passkey anlegen') : t('Speichern')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
