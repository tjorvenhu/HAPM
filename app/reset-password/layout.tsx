import type { Metadata } from 'next';

// Wie bei /login: außerhalb der App-Hülle, also eigener Titel. Der Token in der
// Adresse soll nicht über den Referrer an andere Seiten gehen.
export const metadata: Metadata = {
  title: 'Passwort festlegen · HAPM',
  referrer: 'no-referrer',
};

export default function ResetPasswordLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
