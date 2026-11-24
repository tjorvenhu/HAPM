'use client';

import { usePathname } from 'next/navigation';

/**
 * Der Browsertitel zu einem Bereich: Produktname, Trennpunkt, Bereich. Ohne
 * Bereich nur der Produktname.
 */
export function documentTitle(appName: string, area: string | null | undefined): string {
  return area ? `${appName} · ${area}` : appName;
}

interface DocumentTitleProps {
  /** Der Produktname, wie er im Tab steht. */
  appName: string;
  /**
   * Der Bereich zu einer Adresse, meist aus der Navigation abgeleitet: ein neuer
   * Menüpunkt bringt so seinen Titel mit, statt ihn zu vergessen.
   */
  areaFor: (pathname: string) => string | null | undefined;
}

/**
 * Der Titel der Seiten als Element, nicht als Zuweisung an `document.title`.
 *
 * Er steht nicht als `metadata` an den Seiten, weil dort fast jede Seite eine
 * Client-Komponente ist und der Export verboten. Ein Effekt, der `document.title`
 * setzt, hält rund zehn Millisekunden: steht im Wurzel-Layout zusätzlich ein
 * fester `title` in `metadata`, schreibt Next den nach jedem Laden und jedem
 * Seitenwechsel zurück. React hebt dieses `<title>` in den Kopf des Dokuments,
 * auch im ausgelieferten HTML. Das Wurzel-Layout darf dann keinen Titel nennen,
 * sonst gibt es zwei, und der feste gewinnt.
 */
export default function DocumentTitle({ appName, areaFor }: DocumentTitleProps) {
  const pathname = usePathname();
  return <title>{documentTitle(appName, areaFor(pathname))}</title>;
}
