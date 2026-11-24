import type { Metadata } from 'next';
import { Instrument_Sans } from 'next/font/google';
import './globals.css';
import './hapm.css';
// Flaggen als SVG: Emoji-Flaggen zeigt Windows nur als Buchstabenpaar.
import 'flag-icons/css/flag-icons.min.css';

// `next/font` holt die Schrift beim Bauen und liefert sie vom eigenen Server.
// `globals.css` hängt die Variable an `--font-sans`.
const instrumentSans = Instrument_Sans({
  subsets: ['latin'],
  variable: '--font-instrument-sans',
  display: 'swap',
});

/*
 * Kein `title` hier. Die App-Seiten bekommen ihn von `DocumentTitle`
 * (`app/(app)/layout.tsx`), Anmeldung und Einrichtung setzen ihn über ihr
 * eigenes `metadata`. Ein fester Titel an dieser Stelle überschriebe den der
 * App-Seiten nach jedem Laden wieder (Begründung in `ui/tool/DocumentTitle.tsx`).
 */
export const metadata: Metadata = {
  description: 'Weboberfläche für HAProxy mit automatischen Zertifikaten',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de" className={instrumentSans.variable}>
      <head>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="icon" href="/favicon-32x32.png" sizes="32x32" type="image/png" />
        <link rel="icon" href="/favicon-96x96.png" sizes="96x96" type="image/png" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      </head>
      <body>{children}</body>
    </html>
  );
}
