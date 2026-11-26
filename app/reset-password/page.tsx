'use client';

import { Suspense, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, KeyRound, LogIn } from 'lucide-react';
import { AuthCard } from '@/ui/auth/AuthCard';
import { msgid } from '@/lib/i18n/translate';
import { useToast } from '@/components/Toast';
import { useT } from '@/lib/i18n/react';

const TITLE = msgid('Passwort festlegen');

export default function ResetPasswordPage() {
  const { t } = useT();
  return (
    <Suspense fallback={<AuthCard standalone title={t(TITLE)} />}>
      <ResetPasswordContent />
    </Suspense>
  );
}

/** Das Ziel des Links aus der Mail: `/reset-password?token=…`. */
function ResetPasswordContent() {
  const token = useSearchParams().get('token') ?? '';
  const { t } = useT();

  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  const { notify } = useToast();
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (password !== repeat) {
      setError(t('Die Passwörter stimmen nicht überein.'));
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
      if (!res.ok) throw new Error(data.error || t('Das Passwort ließ sich nicht speichern.'));
      setDone(true);
    } catch (err: unknown) {
      notify({
        variant: 'error',
        title: t('Speichern fehlgeschlagen'),
        message: err instanceof Error ? err.message : t('Das Passwort ließ sich nicht speichern.'),
      });
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <AuthCard standalone title={t(TITLE)}>
        <div className="auth-form">
          <div className="auth-error" role="alert">{t('Der Link ist unvollständig. Bitte fordern Sie einen neuen an.')}</div>
          <Link href="/forgot-password" className="auth-submit">
            <KeyRound size={15} /> {t('Neuen Link anfordern')}
          </Link>
        </div>
      </AuthCard>
    );
  }

  if (done) {
    return (
      <AuthCard standalone title={t(TITLE)}>
        <div className="auth-form">
          <div className="auth-success">
            {t('Ihr Passwort ist gespeichert. Alle Sitzungen dieses Kontos sind beendet.')}
          </div>
          <Link href="/login" className="auth-submit">
            <LogIn size={15} /> {t('Zur Anmeldung')}
          </Link>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard standalone title={t(TITLE)} subtitle={t('Geben Sie Ihr neues Passwort ein.')}>
      <form className="auth-form" onSubmit={handleSubmit}>
        <div className="auth-field">
          <label htmlFor="newPassword">{t('Neues Passwort')}</label>
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
          <label htmlFor="repeatPassword">{t('Passwort wiederholen')}</label>
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
        <p className="auth-hint">{t('Mindestens 10 Zeichen mit Groß- und Kleinbuchstaben und einer Zahl.')}</p>
        {error && <div className="auth-error" role="alert">{error}</div>}
        <button className="auth-submit" type="submit" disabled={loading || !password || !repeat}>
          {loading ? <span className="btn-spinner" aria-hidden="true" /> : <KeyRound size={15} />}
          {loading ? t('Speichern…') : t('Passwort speichern')}
        </button>
      </form>
      <Link href="/login" className="two-factor-btn two-factor-btn--ghost auth-link">
        <ArrowLeft size={15} /> {t('Zurück zur Anmeldung')}
      </Link>
    </AuthCard>
  );
}
