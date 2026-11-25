import type { Metadata } from 'next';
import { getT } from '@/lib/i18n/server';
import { loadToolName } from '@/lib/branding/store';

// Wie bei /login: außerhalb der App-Hülle, also eigener Titel. Der Token in der
// Adresse soll nicht über den Referrer an andere Seiten gehen.
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  const name = await loadToolName();
  return {
    title: `${t('Passwort festlegen')} · ${name}`,
    referrer: 'no-referrer',
  };
}

export default function ResetPasswordLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
