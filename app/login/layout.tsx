import type { Metadata } from 'next';
import { getT } from '@/lib/i18n/server';

// Die Anmeldung liegt außerhalb der App-Hülle, `DocumentTitle` greift hier nicht.
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return {
    title: `${t('Anmeldung')} · HAPM`,
  };
}

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
