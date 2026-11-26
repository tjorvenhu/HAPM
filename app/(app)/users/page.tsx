'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Loader2, Plus, Trash2, X } from 'lucide-react';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { useApp } from '@/components/AppShell';
import { useConfirm } from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import { errorText } from '@/components/errorText';
import { usePolling } from '@/components/usePolling';
import { SkeletonRows } from '@/components/Skeleton';
import { formatDate, formatDateTimeMedium } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';
// Nur der Typ: die Datei dahinter erreicht den Anmeldedienst und damit `lib/db`.
import type { PublicUser } from '@/lib/auth/users';

export default function UsersPage() {
  const { apiFetch, session } = useApp();
  const confirm = useConfirm();
  const { notify } = useToast();
  const { t, locale } = useT();

  const [users, setUsers] = useState<PublicUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/users');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setUsers(data.data);
      setError('');
    } catch {
      setError(t('Die Benutzer konnten nicht geladen werden.'));
    } finally {
      setLoading(false);
    }
  }, [apiFetch, t]);

  useEffect(() => {
    load();
  }, [load]);

  // Konten können in einem anderen Fenster entstehen oder verschwinden.
  usePolling(load, 30_000);

  function openCreate() {
    setName('');
    setEmail('');
    setPassword('');
    setModalOpen(true);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await apiFetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('Das Konto ließ sich nicht anlegen.'));

      await load();
      setModalOpen(false);
      notify({ variant: 'success', message: t('Das Konto für {email} ist angelegt.', { email: data.data.email }) });
    } catch (err: unknown) {
      notify({
        variant: 'error',
        title: t('Anlegen fehlgeschlagen'),
        message: errorText(err, t('Das Konto ließ sich nicht anlegen.')),
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(user: PublicUser) {
    await confirm({
      title: t('Benutzer löschen'),
      message: t('Soll das Konto von {name} ({email}) gelöscht werden? Die Person ist danach sofort abgemeldet.', {
        name: user.name,
        email: user.email,
      }),
      confirmLabel: t('Löschen'),
      variant: 'danger',
      failedTitle: t('Löschen fehlgeschlagen'),
      onConfirm: async () => {
        const res = await apiFetch(`/api/users/${user.$id}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || t('Das Konto ließ sich nicht löschen.'));
        await load();
        notify({ variant: 'success', message: t('Das Konto von {name} ist gelöscht.', { name: user.name }) });
      },
    });
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('Benutzer')}</h1>
          <p className="page-subtitle">{t('Jedes Konto darf alles. Es gibt keine Rollen.')}</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={openCreate}>
            <Plus size={16} />
            {t('Benutzer anlegen')}
          </button>
        </div>
      </div>

      {error && <div className="alert alert-danger sys-block">{error}</div>}

      {loading ? (
        <SkeletonRows />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('E-Mail')}</th>
                <th>{t('Name')}</th>
                <th>{t('Zweiter Faktor')}</th>
                <th>{t('Passkeys')}</th>
                <th>{t('Letzte Anmeldung')}</th>
                <th>{t('Angelegt')}</th>
                <th aria-label={t('Aktionen')} />
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const own = user.$id === session.userId;
                return (
                  <tr key={user.$id}>
                    <td>
                      {user.email}
                      {own && (
                        <span className="badge-status badge-neutral" style={{ marginLeft: 8 }}>
                          {t('Sie')}
                        </span>
                      )}
                    </td>
                    <td>{user.name}</td>
                    <td>
                      <span className={`badge-status ${user.totpEnabled ? 'badge-success' : 'badge-neutral'}`}>
                        <span className="dot" />
                        {user.totpEnabled ? t('Ja') : t('Nein')}
                      </span>
                    </td>
                    <td>{user.passkeyCount}</td>
                    <td>{user.lastLoginAt ? formatDateTimeMedium(locale, user.lastLoginAt) : t('noch nie')}</td>
                    <td>{formatDate(locale, user.$createdAt)}</td>
                    <td>
                      <div className="actions" style={{ justifyContent: 'flex-end' }}>
                        <button
                          className="btn btn-ghost btn-icon btn-sm"
                          data-tooltip={own ? t('Das eigene Konto lässt sich nicht löschen') : t('Löschen')}
                          data-tooltip-pos="left"
                          aria-label={t('{name} löschen', { name: user.name })}
                          disabled={own}
                          onClick={() => handleDelete(user)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {modalOpen && (
        <div
          className="modal-overlay"
          onClick={(e) => e.target === e.currentTarget && !saving && setModalOpen(false)}
        >
          <div className="modal">
            <div className="modal-header">
              <h2 className="modal-title">{t('Benutzer anlegen')}</h2>
              <button
                type="button"
                className="modal-close"
                onClick={() => setModalOpen(false)}
                disabled={saving}
                aria-label={t('Dialog schließen')}
              >
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label" htmlFor="userName">{t('Name')}</label>
                  <input
                    id="userName"
                    className="form-input"
                    required
                    maxLength={100}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t('Max Mustermann')}
                    autoComplete="off"
                    autoFocus
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="userEmail">{t('E-Mail-Adresse')}</label>
                  <input
                    id="userEmail"
                    className="form-input"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={t('max@example.com')}
                    autoComplete="off"
                  />
                </div>

                <div className="form-group">
                  <div className="form-label-row">
                    <label className="form-label" htmlFor="userPassword">{t('Passwort')}</label>
                    <InfoHint text={t('Das Passwort geben Sie selbst an die Person weiter. HAPM verschickt es nicht.')} />
                  </div>
                  <input
                    id="userPassword"
                    className="form-input"
                    type="password"
                    required
                    minLength={10}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                  />
                  <p className="form-hint">{t('Mindestens 10 Zeichen mit Groß- und Kleinbuchstaben und einer Zahl.')}</p>
                </div>
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setModalOpen(false)}
                  disabled={saving}
                >
                  {t('Abbrechen')}
                </button>
                <button className="btn btn-primary" type="submit" disabled={saving}>
                  {saving ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
                  {t('Anlegen')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
