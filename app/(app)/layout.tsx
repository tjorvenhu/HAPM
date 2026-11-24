import AppShell from '@/components/AppShell';
import DocumentTitle from '@/components/DocumentTitle';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* Neben der Hülle und nicht in ihr: der Titel soll auch stimmen, solange die
          Sitzung lädt, und dann zeigt die Hülle ihre Kinder nicht. */}
      <DocumentTitle />
      <AppShell>{children}</AppShell>
    </>
  );
}
