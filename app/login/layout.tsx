import type { Metadata } from 'next';

// Die Anmeldung liegt außerhalb der App-Hülle, `DocumentTitle` greift hier nicht.
export const metadata: Metadata = {
  title: 'Anmeldung · HAPM',
};

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
