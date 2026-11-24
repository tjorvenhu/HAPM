'use client';

import { usePathname } from 'next/navigation';
import { activeArea } from './Sidebar';

/** Der Produktname, wie er im Tab steht. */
export const APP_SHORT_NAME = 'HAPM';

/** Der Browsertitel zu einer Adresse: „Zertifikate · HAPM". Die Seite kommt aus der Navigation. */
export function documentTitle(pathname: string): string {
  const page = activeArea(pathname);
  return page ? `${page} · ${APP_SHORT_NAME}` : APP_SHORT_NAME;
}

/**
 * Der Titel der App-Seiten als `<title>`-Element, nicht als Zuweisung an
 * `document.title`: React hebt das Element in den Kopf, auch im ausgelieferten
 * HTML, und ein Effekt hielte nur bis zum nächsten Seitenwechsel (Begründung in
 * `ui/tool/DocumentTitle.tsx`). Der Baustein dort schreibt den Namen des
 * Werkzeugs nach vorn, hier steht die Seite vorn.
 *
 * Das Wurzel-Layout nennt deshalb keinen Titel. Anmeldung und Einrichtung
 * liegen außerhalb von `app/(app)` und setzen ihren über `metadata`.
 */
export default function DocumentTitle() {
  const pathname = usePathname();
  return <title>{documentTitle(pathname)}</title>;
}
