import type { Metadata } from 'next';

// Wie bei /login: außerhalb der App-Hülle, also eigener Titel.
export const metadata: Metadata = {
  title: 'Passwort vergessen · HAPM',
};

export default function ForgotPasswordLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
