'use client';

import { Suspense, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, KeyRound, LogIn } from 'lucide-react';
import { AuthCard } from '@/ui/auth/AuthCard';

const TITLE = 'Passwort festlegen';

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<AuthCard standalone title={TITLE} />}>
      <ResetPasswordContent />
    </Suspense>
  );
}

/** Das Ziel des Links aus der Mail: `/reset-password?token=…`. */
function ResetPasswordContent() {
  const token = useSearchParams().get('token') ?? '';

  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (password !== repeat) {
      setError('Die Passwörter stimmen nicht überein.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Das Passwort ließ sich nicht speichern.');
      setDone(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Das Passwort ließ sich nicht speichern.');
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <AuthCard standalone title={TITLE}>
        <div className="auth-form">
          <div className="auth-error">Der Link ist unvollständig. Bitte fordern Sie einen neuen an.</div>
          <Link href="/forgot-password" className="auth-submit">
            <KeyRound size={15} /> Neuen Link anfordern
          </Link>
        </div>
      </AuthCard>
    );
  }

  if (done) {
    return (
      <AuthCard standalone title={TITLE}>
        <div className="auth-form">
          <div className="auth-success">
            Ihr Passwort ist gespeichert. Alle Sitzungen dieses Kontos sind beendet.
          </div>
          <Link href="/login" className="auth-submit">
            <LogIn size={15} /> Zur Anmeldung
          </Link>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard standalone title={TITLE} subtitle="Geben Sie Ihr neues Passwort ein.">
      <form className="auth-form" onSubmit={handleSubmit}>
        <div className="auth-field">
          <label htmlFor="newPassword">Neues Passwort</label>
          <input
            id="newPassword"
            type="password"
            required
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••••"
            autoComplete="new-password"
            autoFocus
          />
        </div>
        <div className="auth-field">
          <label htmlFor="repeatPassword">Passwort wiederholen</label>
          <input
            id="repeatPassword"
            type="password"
            required
            minLength={10}
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
            placeholder="••••••••••"
            autoComplete="new-password"
          />
        </div>
        <p className="auth-hint">Mindestens 10 Zeichen mit Groß- und Kleinbuchstaben und einer Zahl.</p>
        {error && <div className="auth-error">{error}</div>}
        <button className="auth-submit" type="submit" disabled={loading || !password || !repeat}>
          {loading ? <span className="btn-spinner" aria-hidden="true" /> : <KeyRound size={15} />}
          {loading ? 'Speichern…' : 'Passwort speichern'}
        </button>
      </form>
      <Link href="/login" className="two-factor-btn two-factor-btn--ghost auth-link">
        <ArrowLeft size={15} /> Zurück zur Anmeldung
      </Link>
    </AuthCard>
  );
}
