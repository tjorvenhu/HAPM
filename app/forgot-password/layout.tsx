import type { Metadata } from 'next';
import { getT } from '@/lib/i18n/server';

// Wie bei /login: außerhalb der App-Hülle, also eigener Titel.
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return {
    title: `${t('Passwort vergessen')} · HAPM`,
  };
}

export default function ForgotPasswordLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
