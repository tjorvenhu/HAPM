import { ToastProvider } from '@/components/Toast';
import type { Metadata } from 'next';
import { getT } from '@/lib/i18n/server';
import { loadToolName } from '@/lib/branding/store';

// Wie bei /login: außerhalb der App-Hülle, also eigener Titel.
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  const name = await loadToolName();
  return {
    title: `${t('Passwort vergessen')} · ${name}`,
  };
}

export default function ForgotPasswordLayout({ children }: { children: React.ReactNode }) {
  // Meldungen nach einer Handlung sind auch hier Toasts (docs/oberflaeche.md).
  return <ToastProvider errorDetails={false}>{children}</ToastProvider>;
}
