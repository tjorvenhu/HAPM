'use client';

import Link from 'next/link';
import { RefreshCw } from 'lucide-react';
import { AuthCard } from '@/ui/auth/AuthCard';
import { useT } from '@/lib/i18n/react';

/**
 * Ein Fehler, den keine Seite selbst abgefangen hat. Ohne diese Datei zeigt
 * Next seine eigene Seite auf Englisch.
 *
 * Die Meldung des Fehlers steht nicht da: im Betrieb ersetzt Next sie durch
 * einen Platzhalter, und was wirklich geschah, steht im Log des Containers.
 */
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t } = useT();
  return (
    <AuthCard
      standalone
      title={t('Das hat nicht geklappt')}
      subtitle={t('Beim Laden der Seite ist ein Fehler aufgetreten. Was geschehen ist, steht im Log des Containers hapm.')}
    >
      <button className="auth-submit" type="button" onClick={reset}>
        <RefreshCw size={15} />
        {t('Erneut versuchen')}
      </button>
      <p className="auth-footer">
        <Link href="/dashboard">{t('Zur Übersicht')}</Link>
      </p>
    </AuthCard>
  );
}
