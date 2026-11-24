'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Loader2, Plus, Trash2, X } from 'lucide-react';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { useApp } from '@/components/AppShell';
import { useConfirm } from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import { usePolling } from '@/components/usePolling';
import { SkeletonRows } from '@/components/Skeleton';
// Nur der Typ: die Datei dahinter erreicht den Anmeldedienst und damit `lib/db`.
import type { PublicUser } from '@/lib/auth/users';

const formatDate = (iso: string) => new Date(iso).toLocaleDateString('de-DE');

const formatDateTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : 'noch nie';

export default function UsersPage() {
  const { apiFetch, session } = useApp();
  const confirm = useConfirm();
  const { notify } = useToast();

  const [users, setUsers] = useState<PublicUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/users');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setUsers(data.data);
      setError('');
    } catch {
      setError('Die Benutzer konnten nicht geladen werden.');
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    load();
  }, [load]);

  // Konten können in einem anderen Fenster entstehen oder verschwinden.
  usePolling(load, 30_000);

  function openCreate() {
    setName('');
    setEmail('');
    setPassword('');
    setFormError('');
    setModalOpen(true);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError('');
    setSaving(true);
    try {
      const res = await apiFetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Das Konto ließ sich nicht anlegen.');

      await load();
      setModalOpen(false);
      notify({ variant: 'success', message: `Das Konto für ${data.data.email} ist angelegt.` });
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Das Konto ließ sich nicht anlegen.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(user: PublicUser) {
    await confirm({
      title: 'Benutzer löschen',
      message: `Soll das Konto von ${user.name} (${user.email}) gelöscht werden? Die Person ist danach sofort abgemeldet.`,
      confirmLabel: 'Löschen',
      variant: 'danger',
      onConfirm: async () => {
        const res = await apiFetch(`/api/users/${user.$id}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) {
          notify({ variant: 'error', message: data.error || 'Das Konto ließ sich nicht löschen.' });
          throw new Error(data.error);
        }
        await load();
        notify({ variant: 'success', message: `Das Konto von ${user.name} ist gelöscht.` });
      },
    });
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Benutzer</h1>
          <p className="page-subtitle">Jedes Konto darf alles. Es gibt keine Rollen.</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={openCreate}>
            <Plus size={16} />
            Benutzer anlegen
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
                <th>E-Mail</th>
                <th>Name</th>
                <th>Zweiter Faktor</th>
                <th>Passkeys</th>
                <th>Letzte Anmeldung</th>
                <th>Angelegt</th>
                <th />
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
                          Sie
                        </span>
                      )}
                    </td>
                    <td>{user.name}</td>
                    <td>
                      <span className={`badge-status ${user.totpEnabled ? 'badge-success' : 'badge-neutral'}`}>
                        <span className="dot" />
                        {user.totpEnabled ? 'Ja' : 'Nein'}
                      </span>
                    </td>
                    <td>{user.passkeyCount}</td>
                    <td>{formatDateTime(user.lastLoginAt)}</td>
                    <td>{formatDate(user.$createdAt)}</td>
                    <td>
                      <div className="actions" style={{ justifyContent: 'flex-end' }}>
                        <button
                          className="btn btn-ghost btn-icon btn-sm"
                          data-tooltip={own ? 'Das eigene Konto lässt sich nicht löschen' : 'Löschen'}
                          data-tooltip-pos="left"
                          aria-label={`${user.name} löschen`}
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
              <h2 className="modal-title">Benutzer anlegen</h2>
              <button
                type="button"
                className="modal-close"
                onClick={() => setModalOpen(false)}
                disabled={saving}
                aria-label="Dialog schließen"
              >
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal-body">
                {formError && <div className="alert alert-danger">{formError}</div>}

                <div className="form-group">
                  <label className="form-label" htmlFor="userName">Name</label>
                  <input
                    id="userName"
                    className="form-input"
                    required
                    maxLength={100}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Max Mustermann"
                    autoComplete="off"
                    autoFocus
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="userEmail">E-Mail-Adresse</label>
                  <input
                    id="userEmail"
                    className="form-input"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="max@example.com"
                    autoComplete="off"
                  />
                </div>

                <div className="form-group">
                  <div className="form-label-row">
                    <label className="form-label" htmlFor="userPassword">Passwort</label>
                    <InfoHint text="Das Passwort geben Sie selbst an die Person weiter. HAPM verschickt es nicht." />
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
                  <p className="form-hint">Mindestens 10 Zeichen mit Groß- und Kleinbuchstaben und einer Zahl.</p>
                </div>
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setModalOpen(false)}
                  disabled={saving}
                >
                  Abbrechen
                </button>
                <button className="btn btn-primary" type="submit" disabled={saving}>
                  {saving ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
                  Anlegen
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
