'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LogIn, ShieldCheck, ArrowLeft } from 'lucide-react';
import { AuthCard } from '@/ui/auth/AuthCard';
import PasskeyLoginButton from '@/components/PasskeyLoginButton';

type LoginStep = 'checking' | 'credentials' | 'twoFactor';

// Beim Anmelden steht nur das Logo: es trägt den Namen schon.
const HEADING: Record<LoginStep, { title: string; subtitle: string }> = {
  checking: { title: '', subtitle: '' },
  credentials: { title: '', subtitle: '' },
  twoFactor: { title: 'Anmeldung bestätigen', subtitle: 'Code aus der Authenticator-App' },
};

export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<LoginStep>('checking');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [csrfToken, setCsrfToken] = useState('');
  // Passkeys gibt es nur, wenn die Adresse von HAPM und ein SMTP-Konto eingerichtet sind.
  const [passkeys, setPasskeys] = useState(false);
  const codeInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      const setup = await fetch('/api/setup').then((r) => r.json());
      if (cancelled) return;
      if (setup.data?.needsSetup) {
        router.replace('/setup');
        return;
      }

      const options = await fetch('/api/auth/options')
        .then((r) => r.json())
        .catch(() => null);
      if (cancelled) return;
      setPasskeys(options?.data?.passkeys === true);

      const me = await fetch('/api/auth/me');
      if (cancelled) return;
      if (!me.ok) {
        setStep('credentials');
        return;
      }
      const session = (await me.json()).data;
      if (cancelled) return;
      if (session?.twoFactorPending) {
        // Hierher schickt die Hülle, wenn das Passwort stimmt und der Code noch fehlt.
        setCsrfToken(session.csrfToken ?? '');
        setStep('twoFactor');
      } else {
        router.replace('/dashboard');
      }
    }

    check().catch(() => {
      if (!cancelled) setStep('credentials');
    });
    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    if (step === 'twoFactor') codeInputRef.current?.focus();
  }, [step]);

  async function handleCredentials(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Die Anmeldung ist fehlgeschlagen.');

      if (data.data?.requiresTwoFactor) {
        setCsrfToken(data.data.csrfToken ?? '');
        setPassword('');
        setStep('twoFactor');
      } else {
        router.push('/dashboard');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Die Anmeldung ist fehlgeschlagen.');
    } finally {
      setLoading(false);
    }
  }

  async function handleTwoFactor(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/2fa/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Der Code ließ sich nicht prüfen.');
      router.push('/dashboard');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Der Code ließ sich nicht prüfen.');
      setCode('');
    } finally {
      setLoading(false);
    }
  }

  async function backToCredentials() {
    // Die Teil-Sitzung beenden, sonst führte jeder Aufruf der Seite wieder zum Code.
    // Abwarten, weil die Antwort den Cookie löscht: käme sie nach einer neuen
    // Anmeldung an, nähme sie deren Cookie mit.
    setLoading(true);
    await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrfToken } }).catch(() => {});
    setLoading(false);
    setCsrfToken('');
    setCode('');
    setError('');
    setStep('credentials');
  }

  return (
    <AuthCard standalone title={HEADING[step].title} subtitle={HEADING[step].subtitle}>
      {step === 'checking' && (
        <>
          <div className="skeleton shell-skeleton--row" />
          <div className="skeleton shell-skeleton--row" />
        </>
      )}

      {step === 'credentials' && (
        <>
          <form className="auth-form" onSubmit={handleCredentials}>
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
                autoFocus
              />
            </div>
            <div className="auth-field">
              <label htmlFor="password">Passwort</label>
              <input
                id="password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••"
                autoComplete="current-password"
              />
            </div>
            <div className="auth-forgot">
              <Link href="/forgot-password">Passwort vergessen?</Link>
            </div>
            {error && <div className="auth-error">{error}</div>}
            <button className="auth-submit" type="submit" disabled={loading}>
              {loading ? <span className="btn-spinner" aria-hidden="true" /> : <LogIn size={15} />}
              {loading ? 'Anmelden…' : 'Anmelden'}
            </button>
          </form>
          {/* Ersetzt Passwort und Code in einem Schritt. */}
          {passkeys && <PasskeyLoginButton onSuccess={() => router.push('/dashboard')} onError={setError} />}
        </>
      )}

      {step === 'twoFactor' && (
        <>
          <form className="auth-form" onSubmit={handleTwoFactor}>
            <div className="auth-intro">
              <ShieldCheck />
              <p>Geben Sie den 6-stelligen Code aus Ihrer Authenticator-App ein.</p>
            </div>
            <div className="auth-field">
              <label htmlFor="twoFactorCode">Code</label>
              <input
                ref={codeInputRef}
                id="twoFactorCode"
                className="auth-code"
                type="text"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                required
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
                autoComplete="one-time-code"
              />
            </div>
            {error && <div className="auth-error">{error}</div>}
            <button className="auth-submit" type="submit" disabled={loading || code.length !== 6}>
              {loading ? <span className="btn-spinner" aria-hidden="true" /> : <ShieldCheck size={16} />}
              {loading ? 'Prüfen…' : 'Bestätigen'}
            </button>
          </form>
          <button
            type="button"
            className="two-factor-btn two-factor-btn--ghost auth-link"
            onClick={backToCredentials}
            disabled={loading}
          >
            <ArrowLeft size={15} /> Zurück zur Anmeldung
          </button>
        </>
      )}
    </AuthCard>
  );
}
