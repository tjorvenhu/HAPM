'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ArrowLeft, Mail } from 'lucide-react';
import { AuthCard } from '@/ui/auth/AuthCard';
import AuthFormSkeleton from '@/ui/auth/AuthFormSkeleton';
import { useT } from '@/lib/i18n/react';

/** `null`, solange die Seite noch nicht weiß, ob diese Installation Mails verschicken kann. */
type Availability = boolean | null;

/**
 * Passwort vergessen. Per Mail geht das nur, wenn die Adresse von HAPM und ein
 * SMTP-Konto eingerichtet sind. Sonst nennt die Seite den Weg über den Server.
 */
export default function ForgotPasswordPage() {
  const { t } = useT();
  const [available, setAvailable] = useState<Availability>(null);
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    fetch('/api/auth/options')
      .then((r) => r.json())
      .then((d) => setAvailable(d.data?.passwordReset === true))
      .catch(() => setAvailable(false));
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('Die Anfrage ist fehlgeschlagen.'));
      setSent(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('Die Anfrage ist fehlgeschlagen.'));
    } finally {
      setLoading(false);
    }
  }

  const subtitle =
    available === false
      ? t('Das Zurücksetzen per E-Mail ist hier nicht eingerichtet.')
      : t('Sie erhalten per E-Mail einen Link für ein neues Passwort.');

  return (
    <AuthCard standalone title={t('Passwort vergessen')} subtitle={subtitle}>
      {available === null && (
        <AuthFormSkeleton fields={1} />
      )}

      {available === false && (
        <div className="auth-form">
          <p className="auth-hint">{t('Ein neues Passwort setzt dieses Kommando auf dem Server:')}</p>
          <p className="auth-hint">
            <code>docker exec -it hapm hapm-admin reset-password &lt;{t('e-mail')}&gt;</code>
          </p>
          <div className="alert alert-warning">
            {t('Es schaltet auch den zweiten Faktor des Kontos ab, entfernt seine Passkeys und beendet seine Sitzungen.')}
          </div>
        </div>
      )}

      {available === true && !sent && (
        <form className="auth-form" onSubmit={handleSubmit}>
          <div className="auth-field">
            <label htmlFor="forgotEmail">{t('E-Mail-Adresse')}</label>
            <input
              id="forgotEmail"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@example.org"
              autoComplete="email"
              autoFocus
            />
          </div>
          {error && <div className="auth-error" role="alert">{error}</div>}
          <button className="auth-submit" type="submit" disabled={loading}>
            {loading ? <span className="btn-spinner" aria-hidden="true" /> : <Mail size={15} />}
            {loading ? t('Senden…') : t('Link senden')}
          </button>
        </form>
      )}

      {available === true && sent && (
        <div className="auth-success">
          {t('Gibt es zu dieser Adresse ein Konto, ist jetzt ein Link dorthin unterwegs. Er gilt eine Stunde.')}
        </div>
      )}

      <Link href="/login" className="two-factor-btn two-factor-btn--ghost auth-link">
        <ArrowLeft size={15} /> {t('Zurück zur Anmeldung')}
      </Link>
    </AuthCard>
  );
}
