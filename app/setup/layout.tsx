import type { Metadata } from 'next';
import { getT } from '@/lib/i18n/server';
import './setup.css';

// Wie bei /login: außerhalb der App-Hülle, also eigener Titel.
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return {
    title: `${t('Einrichtung')} · HAPM`,
  };
}

export default function SetupLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
