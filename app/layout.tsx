import type { Metadata } from 'next';
import { Instrument_Sans } from 'next/font/google';
import { I18nProvider } from '@/lib/i18n/react';
import { TooltipLayer } from '@/ui/tool/TooltipLayer';
import { getRequestLocale } from '@/lib/i18n/server';
import { translate } from '@/lib/i18n';
import { BrandProvider } from '@/ui/primitives/brand';
import { loadBrandingSafe } from '@/lib/branding/store';
import { brandingStyle, faviconHref, publicBranding } from '@/lib/branding/branding';
import './globals.css';
import './hapm.css';
import './branding.css';
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
export async function generateMetadata(): Promise<Metadata> {
  const locale = await getRequestLocale();
  return {
    description: translate(locale, 'Weboberfläche für HAProxy mit automatischen Zertifikaten'),
    robots: { index: false, follow: false },
  };
}

/*
 * Das eigene Aussehen (`lib/branding/`) liest das Layout bei jeder Seite aus
 * der Datenbank, eine Zeile über ihren Schlüssel. Ohne Datenbank gilt das von
 * HAPM (`loadBrandingSafe`).
 *
 * Die Sprache aus Cookie oder Browser, ohne Blick auf das Konto: das Layout
 * läuft bei jeder Seite, und das Cookie spiegelt die Wahl am Konto
 * (`lib/i18n/server.ts`). Der Provider liegt um alle Seiten, auch um Anmeldung,
 * Einrichtung und die Fehlerseiten.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Nacheinander: erst die Kopfzeilen der Anfrage. Ohne Anfrage (Vorab-Rendern
  // beim Bauen) bricht Next dort ab, bevor jemand die Datenbank fragt.
  const locale = await getRequestLocale();
  const branding = await loadBrandingSafe();
  // Farben und Symbol stehen schon in der ersten Antwort: nichts blitzt im Grün von HAPM auf.
  const style = brandingStyle(branding);
  const favicon = faviconHref(branding);
  return (
    <html lang={locale} className={instrumentSans.variable}>
      <head>
        {style && <style id="hapm-branding" dangerouslySetInnerHTML={{ __html: style }} />}
        {favicon ? (
          <>
            <link rel="icon" href={favicon} />
            <link rel="apple-touch-icon" href={favicon} />
          </>
        ) : (
          <>
            <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
            <link rel="icon" href="/favicon-32x32.png" sizes="32x32" type="image/png" />
            <link rel="icon" href="/favicon-96x96.png" sizes="96x96" type="image/png" />
            <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
          </>
        )}
      </head>
      <body>
        <I18nProvider initialLocale={locale}>
          <BrandProvider value={publicBranding(branding)}>
            {children}
            <TooltipLayer />
          </BrandProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
