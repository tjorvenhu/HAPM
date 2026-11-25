import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { AuthCard } from '@/ui/auth/AuthCard';
import { getT } from '@/lib/i18n/server';
import { loadToolName } from '@/lib/branding/store';

// Steht außerhalb der App-Hülle, `DocumentTitle` greift hier nicht.
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  const name = await loadToolName();
  return { title: `${t('Seite nicht gefunden')} · ${name}` };
}

/**
 * Jede Adresse, die es in HAPM nicht gibt. Ohne diese Datei zeigt Next seine
 * eigene, schwarze Seite auf Englisch.
 *
 * Der Knopf führt zur Übersicht: wer nicht angemeldet ist, landet von dort bei
 * der Anmeldung.
 */
export default async function NotFound() {
  const { t } = await getT();
  return (
    <AuthCard
      standalone
      title={t('Seite nicht gefunden')}
      subtitle={t('Unter dieser Adresse gibt es in HAPM nichts. Vielleicht ist der Link veraltet oder falsch geschrieben.')}
    >
      <Link className="auth-submit" href="/dashboard">
        <ArrowLeft size={15} />
        {t('Zur Übersicht')}
      </Link>
    </AuthCard>
  );
}
