'use client';

import { usePathname } from 'next/navigation';
import { useT } from '@/lib/i18n/react';
import { activeArea } from './Sidebar';

/** Der Produktname, wie er im Tab steht. */
export const APP_SHORT_NAME = 'HAPM';

/**
 * Der Browsertitel zu einer Adresse: „Zertifikate · HAPM". Die Seite kommt aus
 * der Navigation, `translate` übersetzt ihren Namen (ohne Angabe bleibt er deutsch).
 */
export function documentTitle(pathname: string, translate: (text: string) => string = (text) => text): string {
  const page = activeArea(pathname);
  return page ? `${translate(page)} · ${APP_SHORT_NAME}` : APP_SHORT_NAME;
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
  return <title>{documentTitle(pathname, t)}</title>;
}
