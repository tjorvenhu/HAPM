import { ToastProvider } from '@/components/Toast';
import type { Metadata } from 'next';
import { getT } from '@/lib/i18n/server';
import { loadToolName } from '@/lib/branding/store';

// Die Anmeldung liegt außerhalb der App-Hülle, `DocumentTitle` greift hier nicht.
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  const name = await loadToolName();
  return {
    title: `${t('Anmeldung')} · ${name}`,
  };
}

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  // Meldungen nach einer Handlung sind auch hier Toasts (docs/oberflaeche.md).
  return <ToastProvider errorDetails={false}>{children}</ToastProvider>;
}
