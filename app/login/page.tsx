'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LogIn, ShieldCheck, ArrowLeft, LifeBuoy, Smartphone } from 'lucide-react';
import { AuthCard } from '@/ui/auth/AuthCard';
import AuthFormSkeleton from '@/ui/auth/AuthFormSkeleton';
import PasskeyLoginButton from '@/components/PasskeyLoginButton';
import { msgid } from '@/lib/i18n/translate';
import { useT } from '@/lib/i18n/react';

type LoginStep = 'checking' | 'credentials' | 'twoFactor';

// Beim Anmelden steht nur das Logo: es trägt den Namen schon.
const HEADING: Record<LoginStep, { title: string; subtitle: string }> = {
  checking: { title: '', subtitle: '' },
  credentials: { title: '', subtitle: '' },
  twoFactor: { title: msgid('Anmeldung bestätigen'), subtitle: msgid('Code aus der Authenticator-App') },
};

export default function LoginPage() {
  const router = useRouter();
  const { t } = useT();
  const [step, setStep] = useState<LoginStep>('checking');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  // Statt des Codes aus der App ein Wiederherstellungscode (`lib/recovery-codes.ts`).
  const [useRecovery, setUseRecovery] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');
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
  }, [step, useRecovery]);

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
      if (!res.ok) throw new Error(data.error || t('Die Anmeldung ist fehlgeschlagen.'));

      if (data.data?.requiresTwoFactor) {
        setCsrfToken(data.data.csrfToken ?? '');
        setPassword('');
        setStep('twoFactor');
      } else {
        router.push('/dashboard');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('Die Anmeldung ist fehlgeschlagen.'));
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
        body: JSON.stringify(useRecovery ? { recoveryCode } : { code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('Der Code ließ sich nicht prüfen.'));
      // Nach einem Wiederherstellungscode auf die Kontoseite: dort steht, wie
      // viele noch übrig sind, und dort entstehen neue.
      router.push(useRecovery ? '/konto?bereich=zweiter-faktor' : '/dashboard');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('Der Code ließ sich nicht prüfen.'));
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
    setRecoveryCode('');
    setUseRecovery(false);
    setError('');
    setStep('credentials');
  }

  return (
    <AuthCard
      standalone
      title={HEADING[step].title && t(HEADING[step].title)}
      subtitle={
        step === 'twoFactor' && useRecovery
          ? t('Wiederherstellungscode')
          : HEADING[step].subtitle && t(HEADING[step].subtitle)
      }
    >
      {step === 'checking' && (
        <AuthFormSkeleton />
      )}

      {step === 'credentials' && (
        <>
          <form className="auth-form" onSubmit={handleCredentials}>
            <div className="auth-field">
              <label htmlFor="email">{t('E-Mail-Adresse')}</label>
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
              <label htmlFor="password">{t('Passwort')}</label>
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
              <Link href="/forgot-password">{t('Passwort vergessen?')}</Link>
            </div>
            {error && <div className="auth-error">{error}</div>}
            <button className="auth-submit" type="submit" disabled={loading}>
              {loading ? <span className="btn-spinner" aria-hidden="true" /> : <LogIn size={15} />}
              {loading ? t('Anmelden…') : t('Anmelden')}
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
              {useRecovery ? <LifeBuoy /> : <ShieldCheck />}
              <p>
                {useRecovery
                  ? t('Geben Sie einen Ihrer Wiederherstellungscodes ein. Er ist danach verbraucht.')
                  : t('Geben Sie den 6-stelligen Code aus Ihrer Authenticator-App ein.')}
              </p>
            </div>
            {useRecovery ? (
              <div className="auth-field">
                <label htmlFor="recoveryCode">{t('Wiederherstellungscode')}</label>
                <input
                  ref={codeInputRef}
                  id="recoveryCode"
                  className="auth-code auth-code--recovery"
                  type="text"
                  required
                  maxLength={16}
                  value={recoveryCode}
                  onChange={(e) => setRecoveryCode(e.target.value)}
                  placeholder="xxxxx-xxxxx"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </div>
            ) : (
              <div className="auth-field">
                <label htmlFor="twoFactorCode">{t('Code')}</label>
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
            )}
            {error && <div className="auth-error">{error}</div>}
            <button
              className="auth-submit"
              type="submit"
              disabled={loading || (useRecovery ? recoveryCode.trim().length === 0 : code.length !== 6)}
            >
              {loading ? <span className="btn-spinner" aria-hidden="true" /> : <ShieldCheck size={16} />}
              {loading ? t('Prüfen…') : t('Bestätigen')}
            </button>
          </form>
          <div className="auth-links">
            <button
              type="button"
              className="two-factor-btn two-factor-btn--ghost auth-link"
              onClick={() => {
                setUseRecovery(!useRecovery);
                setError('');
              }}
              disabled={loading}
            >
              {useRecovery ? <Smartphone size={15} /> : <LifeBuoy size={15} />}{' '}
              {useRecovery ? t('Code aus der App verwenden') : t('Wiederherstellungscode verwenden')}
            </button>
            <button
              type="button"
              className="two-factor-btn two-factor-btn--ghost auth-link"
              onClick={backToCredentials}
              disabled={loading}
            >
              <ArrowLeft size={15} /> {t('Zurück zur Anmeldung')}
            </button>
          </div>
        </>
      )}
    </AuthCard>
  );
}
