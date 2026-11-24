/**
 * Die Seiten, die aus einem Design entstehen: welche es gibt, was auf der
 * Platte stünde, und ob jede in HAProxys Puffer passt.
 *
 * Die eine Stelle, an der Vorschau, Größenanzeige und Prüfung dasselbe rechnen.
 * Das Formular ruft sie im Browser mit dem Entwurf auf, die Route auf dem Server
 * mit dem, was gespeichert werden soll: die Vorschau zeigt deshalb genau das
 * Dokument, das HAProxy danach ausliefert, und keine zweite Fassung davon.
 *
 * Rein, wie `page-design.ts`.
 */

import { defaultErrorPageText, errorPageStatuses, renderErrorFile } from './error-pages';
import { renderLockPage, type LockPageKind } from './lock-page';
import { PAGE_MAX_BYTES, type PageDesign } from './page-design';

export type DesignPage =
  | { id: string; label: string; hint: string; kind: 'error'; status: number }
  | { id: string; label: string; hint: string; kind: 'lock'; lock: LockPageKind };

/** Wann HAProxy eine Seite zeigt. Für die Auswahl in der Vorschau. */
const ERROR_HINTS: Partial<Record<number, { label: string; hint: string }>> = {
  404: { label: 'Unbekannte Domain', hint: 'Für diese Domain ist kein Ziel eingerichtet.' },
  403: { label: 'Gesperrt', hint: 'Die Sperre auf Admin-IPs greift.' },
  502: { label: 'Fehlerhafte Antwort', hint: 'Das Ziel antwortet, aber nicht verständlich.' },
  503: { label: 'Ziel nicht erreichbar', hint: 'Kein Server des Ziels nimmt Verbindungen an.' },
  504: { label: 'Zeitüberschreitung', hint: 'Das Ziel antwortet nicht rechtzeitig.' },
};

/** Die Fälle, die ein Besucher am ehesten sieht, stehen vorn. */
const FIRST = [404, 403, 502, 503, 504];

function errorPage(status: number): DesignPage {
  const known = ERROR_HINTS[status];
  return {
    id: `error-${status}`,
    kind: 'error',
    status,
    label: `${status} · ${known?.label ?? defaultErrorPageText(status).title}`,
    hint: known?.hint ?? 'Seltener Fall, HAProxy meldet ihn selbst.',
  };
}

const LOCK_PAGES: DesignPage[] = [
  { id: 'lock-ask', kind: 'lock', lock: 'ask', label: 'Passwortabfrage', hint: 'Vor einer Domain mit Passwortsperre.' },
  {
    id: 'lock-wrong',
    kind: 'lock',
    lock: 'wrong',
    label: 'Passwortabfrage · falsches Passwort',
    hint: 'Nach einer falschen Eingabe.',
  },
  {
    id: 'lock-throttled',
    kind: 'lock',
    lock: 'throttled',
    label: 'Passwortabfrage · zu viele Versuche',
    hint: 'Nach zehn Eingaben in zehn Minuten.',
  },
];

export const DESIGN_PAGES: DesignPage[] = [
  ...FIRST.map(errorPage),
  ...LOCK_PAGES,
  ...errorPageStatuses()
    .filter((status) => !FIRST.includes(status))
    .map(errorPage),
];

/** Was für diese Seite auf der Platte stünde: bei einer Fehlerseite die ganze
 *  HTTP-Antwort, bei der Passwortabfrage das Dokument. */
export function designPageFile(page: DesignPage, design: PageDesign): string {
  return page.kind === 'error' ? renderErrorFile(page.status, design) : renderLockPage(page.lock, design);
}

/** Das Dokument allein, für die Vorschau. */
export function designPageHtml(page: DesignPage, design: PageDesign): string {
  const file = designPageFile(page, design);
  if (page.kind === 'lock') return file;
  return file.slice(file.indexOf('\r\n\r\n') + 4);
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export interface DesignPageSize {
  page: DesignPage;
  bytes: number;
}

/** Die Größe jeder Seite, die größte zuerst. */
export function designPageSizes(design: PageDesign): DesignPageSize[] {
  return DESIGN_PAGES.map((page) => ({ page, bytes: byteLength(designPageFile(page, design)) })).sort(
    (a, b) => b.bytes - a.bytes
  );
}

/**
 * Wie groß eine Logo-Datei höchstens sein darf, damit jede Seite mit den
 * jetzigen Texten noch passt.
 *
 * Gerechnet für Base64, das aus drei Bytes vier macht. Ein SVG geht nur dann
 * prozentkodiert in die Seite, wenn das kürzer ist (`logoDataUri`): für SVG ist
 * die Zahl also die sichere Seite, für die anderen Typen genau die Grenze.
 * Ohne eigenes Logo gilt der längste Kopf einer Data-URI, der eines SVG.
 */
export function logoByteBudget(design: PageDesign): number {
  // Die Seiten mit einem leeren Bild: Rahmen, Texte, `<img>` und der Kopf der
  // Data-URI. Jede Seite bekommt dasselbe Logo, die größte bleibt die größte.
  const mime = design.logo.kind === 'custom' ? design.logo.mime : 'image/svg+xml';
  const empty: PageDesign = { ...design, logo: { kind: 'custom', mime, data: '' } };
  const free = PAGE_MAX_BYTES - designPageSizes(empty)[0].bytes;
  return Math.max(0, Math.floor(free / 4) * 3);
}

const number = (value: number) => value.toLocaleString('de-DE');

/** Der Grund, warum ein Design nicht ausgeliefert werden kann, oder `null`. */
export function designSizeError(design: PageDesign): string | null {
  const largest = designPageSizes(design)[0];
  if (largest.bytes <= PAGE_MAX_BYTES) return null;

  if (design.logo.kind === 'custom') {
    return (
      `Das Logo passt nicht in die Seite. Mit ihm hätte „${largest.page.label}“ ${number(largest.bytes)} Bytes, ` +
      `HAProxy lädt höchstens ${number(PAGE_MAX_BYTES)}. ` +
      `Mit den jetzigen Texten darf die Logo-Datei höchstens ${number(logoByteBudget(design))} Bytes groß sein.`
    );
  }
  return (
    `„${largest.page.label}“ hätte ${number(largest.bytes)} Bytes, HAProxy lädt höchstens ` +
    `${number(PAGE_MAX_BYTES)}. Kürzen Sie die Texte.`
  );
}
