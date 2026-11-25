import type { Metadata } from 'next';
import { getT } from '@/lib/i18n/server';
import { loadToolName } from '@/lib/branding/store';
import './setup.css';

// Wie bei /login: außerhalb der App-Hülle, also eigener Titel.
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  const name = await loadToolName();
  return {
    title: `${t('Einrichtung')} · ${name}`,
  };
}

export default function SetupLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
