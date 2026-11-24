/**
 * Wo das Design der Fehlerseiten liegt: eine Zeile in der Datenbank
 * (Collection `page_design`, Kennung `PAGE_DESIGN_ID`).
 *
 * In der Datenbank und nicht neben `haproxy.cfg`, anders als fast alles am
 * Reverse-Proxy: die Datei auf der Platte ist das ERGEBNIS (eine fertige Seite
 * je Status), und aus ihr ließe sich nicht zurücklesen, welche Farbe gewählt
 * und welcher Text nur die Vorgabe war. Was HAProxy ausliefert, sagt weiterhin
 * die Datei: ihr Zustand wird bei jedem Blick an ihr selbst abgelesen
 * (`planErrorPages`), nicht an dieser Zeile.
 *
 * Jedes Lesen und Schreiben setzt zugleich das Design, das im Prozess gilt
 * (`setActiveDesign`), siehe `page-design.ts`.
 */

import { COLLECTIONS, getSingleton, updateDocument } from '../db';
import { defaultPageDesign, parsePageDesign, setActiveDesign, type PageDesign } from './page-design';

export const PAGE_DESIGN_ID = 'main';

export async function loadPageDesign(): Promise<PageDesign> {
  const row = await getSingleton<PageDesign>(COLLECTIONS.PAGE_DESIGN, PAGE_DESIGN_ID, defaultPageDesign());
  const parsed = parsePageDesign(row);
  if (!parsed.ok) {
    // Eine Zeile, die die eigene Prüfung nicht mehr besteht, etwa nach einer
    // enger gewordenen Regel. Die Seiten müssen trotzdem entstehen können.
    console.error(`[fehlerseiten] Das gespeicherte Design ist ungültig, es gilt das von HAPM: ${parsed.error}`);
  }
  const design = parsed.ok ? parsed.design : defaultPageDesign();
  setActiveDesign(design);
  return design;
}

/** Erwartet ein geprüftes Design (`parsePageDesign`, `designSizeError`). */
export async function savePageDesign(design: PageDesign): Promise<PageDesign> {
  await getSingleton<PageDesign>(COLLECTIONS.PAGE_DESIGN, PAGE_DESIGN_ID, defaultPageDesign());
  // `updateDocument` mischt auf der obersten Ebene. Das Design nennt jedes
  // seiner Felder, also bleibt von der alten Zeile nichts stehen.
  await updateDocument<PageDesign>(COLLECTIONS.PAGE_DESIGN, PAGE_DESIGN_ID, design);
  setActiveDesign(design);
  return design;
}
