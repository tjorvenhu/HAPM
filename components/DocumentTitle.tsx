'use client';

import { usePathname } from 'next/navigation';
import { useT } from '@/lib/i18n/react';
import { useBrand } from '@/ui/primitives/brand';
import { activeArea } from './Sidebar';

/** Der Produktname, wie er im Tab steht, solange unter „Darstellung" kein eigener gesetzt ist. */
export const APP_SHORT_NAME = 'HAPM';

/**
 * Der Browsertitel zu einer Adresse: „Zertifikate · HAPM". Die Seite kommt aus
 * der Navigation, `translate` übersetzt ihren Namen (ohne Angabe bleibt er deutsch).
 */
export function documentTitle(
  pathname: string,
  translate: (text: string) => string = (text) => text,
  appName: string = APP_SHORT_NAME
): string {
  const page = activeArea(pathname);
  return page ? `${translate(page)} · ${appName}` : appName;
}

/**
 * Der Titel der App-Seiten als `<title>`-Element, nicht als Zuweisung an
 * `document.title`: React hebt das Element in den Kopf, auch im ausgelieferten
 * HTML, und ein Effekt hielte nur bis zum nächsten Seitenwechsel (Begründung in
 * `ui/tool/DocumentTitle.tsx`). Der Baustein dort schreibt den Namen des
 * Werkzeugs nach vorn, hier steht die Seite vorn.
 *
 * Das Wurzel-Layout nennt deshalb keinen Titel. Anmeldung und Einrichtung
 * liegen außerhalb von `app/(app)` und setzen ihren über `generateMetadata`.
 */
export default function DocumentTitle() {
  const pathname = usePathname();
  const { t } = useT();
  const brand = useBrand();
  return <title>{documentTitle(pathname, t, brand.name ?? APP_SHORT_NAME)}</title>;
}
