'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, UserPlus } from 'lucide-react';
import { AuthCard } from '@/ui/auth/AuthCard';
import { InfoHint } from '@/ui/primitives/InfoHint';

/**
 * Die Ersteinrichtung. Nur erreichbar, solange es kein Konto gibt. Die Route
 * setzt das selbst durch, die Seite vermeidet nur ein totes Formular.
 */
export default function SetupPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  // Folgt der Konto-Adresse, bis jemand das Feld selbst anfasst.
  const [acmeEmail, setAcmeEmail] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  /** Das Konto steht, acme.sh nicht: das muss man lesen, bevor es weitergeht. */
  const [acmeProblem, setAcmeProblem] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/setup')
      .then((r) => r.json())
      .then((d) => {
        if (d.data?.needsSetup === false) router.replace('/login');
        else setChecking(false);
      })
      .catch(() => setChecking(false));
  }, [router]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('Die Passwörter stimmen nicht überein.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password, acmeEmail: acmeEmail ?? email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Die Einrichtung ist fehlgeschlagen.');

      if (data.data?.acme?.ok === false) {
        setAcmeProblem(data.data.acme.detail || 'Ohne nähere Angabe.');
      } else {
        router.push('/dashboard');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Die Einrichtung ist fehlgeschlagen.');
    } finally {
      setLoading(false);
    }
  }

  if (checking) {
    return (
      <AuthCard standalone title="HAPM einrichten">
        <div className="skeleton shell-skeleton--row" />
        <div className="skeleton shell-skeleton--row" />
      </AuthCard>
    );
  }

  if (acmeProblem !== null) {
    return (
      <AuthCard
        standalone
        title="Konto angelegt"
        subtitle="Sie sind angemeldet. acme.sh ließ sich aber nicht einrichten."
      >
        <div className="auth-form">
          <div className="auth-error">{acmeProblem}</div>
          <p className="auth-hint">
            Solange das so ist, lassen sich keine Zertifikate ausstellen. Beim nächsten Start
            versucht HAPM die Einrichtung erneut.
          </p>
          <button className="auth-submit" type="button" onClick={() => router.push('/dashboard')}>
            <ArrowRight size={15} />
            Weiter zum Dashboard
          </button>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      standalone
      title="HAPM einrichten"
      subtitle="HAProxy und acme.sh hat HAPM beim Start eingerichtet. Legen Sie jetzt das erste Konto an. Danach können Sie das erste Ziel anlegen."
    >
      <form className="auth-form" onSubmit={handleSubmit}>
        <div className="auth-field">
          <label htmlFor="name">Name</label>
          <input
            id="name"
            type="text"
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Max Mustermann"
            autoComplete="name"
            autoFocus
          />
        </div>
        <div className="auth-field">
          <label htmlFor="email">E-Mail-Adresse</label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="admin@example.com"
            autoComplete="email"
          />
        </div>
        <div className="auth-field">
          <label htmlFor="password">Passwort</label>
          <input
            id="password"
            type="password"
            required
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••••"
            autoComplete="new-password"
          />
        </div>
        <div className="auth-field">
          <label htmlFor="confirmPassword">Passwort wiederholen</label>
          <input
            id="confirmPassword"
            type="password"
            required
            minLength={10}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="••••••••••"
            autoComplete="new-password"
          />
        </div>
        <p className="auth-hint">Mindestens 10 Zeichen mit Groß- und Kleinbuchstaben und einer Zahl.</p>
        <div className="auth-field">
          <label htmlFor="acmeEmail">
            E-Mail für Let&apos;s Encrypt
            <InfoHint text="Mit dieser Adresse meldet acme.sh das Konto bei Let's Encrypt an, über das die Zertifikate ausgestellt werden. Vorgabe ist die Adresse Ihres Kontos." />
          </label>
          <input
            id="acmeEmail"
            type="email"
            required
            value={acmeEmail ?? email}
            onChange={(e) => setAcmeEmail(e.target.value)}
            placeholder="admin@example.com"
            autoComplete="email"
          />
        </div>
        {error && <div className="auth-error">{error}</div>}
        <button className="auth-submit" type="submit" disabled={loading}>
          {loading ? <span className="btn-spinner" aria-hidden="true" /> : <UserPlus size={15} />}
          {loading ? 'Einrichten…' : 'Konto anlegen'}
        </button>
      </form>
    </AuthCard>
  );
}
