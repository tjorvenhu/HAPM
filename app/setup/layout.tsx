import type { Metadata } from 'next';

// Wie bei /login: außerhalb der App-Hülle, also eigener Titel.
export const metadata: Metadata = {
  title: 'Einrichtung · HAPM',
};

export default function SetupLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
