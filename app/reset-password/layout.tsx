import type { Metadata } from 'next';
import { getT } from '@/lib/i18n/server';

// Wie bei /login: außerhalb der App-Hülle, also eigener Titel. Der Token in der
// Adresse soll nicht über den Referrer an andere Seiten gehen.
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return {
    title: `${t('Passwort festlegen')} · HAPM`,
    referrer: 'no-referrer',
  };
}

export default function ResetPasswordLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
