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

import { createTranslator, DEFAULT_LOCALE, formatNumber, msgid, type Locale } from '@/lib/i18n';
import { defaultErrorPageText, errorPageStatuses, renderErrorFile } from './error-pages';
import { renderLockPage, type LockPageKind } from './lock-page';
import { PAGE_MAX_BYTES, type PageDesign } from './page-design';

/**
 * Eine Seite für die Auswahl in Formular und Vorschau. `label` und `hint` sind
 * Schlüssel (`msgid`) in der Sprache der Oberfläche: die Seite zeigt sie mit
 * `t()`, eine Fehlerseite mit ihrem Status davor (`designPageLabel`).
 */
export type DesignPage =
  | { id: string; label: string; hint: string; kind: 'error'; status: number }
  | { id: string; label: string; hint: string; kind: 'lock'; lock: LockPageKind };

/** Wann HAProxy eine Seite zeigt. Für die Auswahl in der Vorschau. */
const ERROR_HINTS: Partial<Record<number, { label: string; hint: string }>> = {
  404: { label: msgid('Unbekannte Domain'), hint: msgid('Für diese Domain ist kein Ziel eingerichtet.') },
  403: { label: msgid('Gesperrt'), hint: msgid('Die Sperre auf Admin-IPs greift.') },
  502: { label: msgid('Fehlerhafte Antwort'), hint: msgid('Das Ziel antwortet, aber nicht verständlich.') },
  503: { label: msgid('Ziel nicht erreichbar'), hint: msgid('Kein Server des Ziels nimmt Verbindungen an.') },
  504: { label: msgid('Zeitüberschreitung'), hint: msgid('Das Ziel antwortet nicht rechtzeitig.') },
};

/** Die Fälle, die ein Besucher am ehesten sieht, stehen vorn. */
const FIRST = [404, 403, 502, 503, 504];

function errorPage(status: number): DesignPage {
  const known = ERROR_HINTS[status];
  return {
    id: `error-${status}`,
    kind: 'error',
    status,
    // Die deutsche Überschrift der Seite ist selbst ein Schlüssel (`ui/static/page.ts`).
    label: known?.label ?? defaultErrorPageText(status).title,
    hint: known?.hint ?? msgid('Seltener Fall, HAProxy meldet ihn selbst.'),
  };
}

const LOCK_PAGES: DesignPage[] = [
  {
    id: 'lock-ask',
    kind: 'lock',
    lock: 'ask',
    label: msgid('Passwortabfrage'),
    hint: msgid('Vor einer Domain mit Passwortsperre.'),
  },
  {
    id: 'lock-wrong',
    kind: 'lock',
    lock: 'wrong',
    label: msgid('Passwortabfrage · falsches Passwort'),
    hint: msgid('Nach einer falschen Eingabe.'),
  },
  {
    id: 'lock-throttled',
    kind: 'lock',
    lock: 'throttled',
    label: msgid('Passwortabfrage · zu viele Versuche'),
    hint: msgid('Nach zehn Eingaben in zehn Minuten.'),
  },
];

/** „503 · Ziel nicht erreichbar" bzw. „Passwortabfrage", übersetzt mit `t`. */
export function designPageLabel(page: DesignPage, t: (text: string) => string): string {
  return page.kind === 'error' ? `${page.status} · ${t(page.label)}` : t(page.label);
}

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
  // Ein Logo gibt es nur in „Selbst gestalten“. Gerechnet wird für diese Art,
  // auch wenn gerade eine andere gewählt ist: das Formular zeigt die Zahl dort.
  const mime = design.logo.kind === 'custom' ? design.logo.mime : 'image/svg+xml';
  const empty: PageDesign = { ...design, mode: 'designed', logo: { kind: 'custom', mime, data: '' } };
  const free = PAGE_MAX_BYTES - designPageSizes(empty)[0].bytes;
  return Math.max(0, Math.floor(free / 4) * 3);
}

/**
 * Der Grund, warum ein Design nicht ausgeliefert werden kann, oder `null`.
 * `messages` ist die Sprache der Oberfläche, nicht die der Seiten.
 *
 * Die eine Prüfung der Größe für Formular und Route, für jede Art: gemessen
 * wird die fertige Datei samt Kopfzeilen, bei eigenem HTML also mit dem
 * längsten Titel und Text, die die Platzhalter einsetzen.
 */
export function designSizeError(design: PageDesign, messages: Locale = DEFAULT_LOCALE): string | null {
  const largest = designPageSizes(design)[0];
  if (largest.bytes <= PAGE_MAX_BYTES) return null;

  const { t } = createTranslator(messages);
  const values = {
    page: designPageLabel(largest.page, t),
    bytes: formatNumber(messages, largest.bytes),
    max: formatNumber(messages, PAGE_MAX_BYTES),
  };
  if (design.mode === 'custom' && largest.page.kind === 'error') {
    return t('Mit diesem HTML und CSS hätte „{page}“ {bytes} Bytes, HAProxy lädt höchstens {max}. Kürzen Sie HTML oder CSS.', values);
  }
  if (design.mode === 'designed' && design.logo.kind === 'custom') {
    return t(
      'Das Logo passt nicht in die Seite. Mit ihm hätte „{page}“ {bytes} Bytes, HAProxy lädt höchstens {max}. Mit den jetzigen Texten darf die Logo-Datei höchstens {budget} Bytes groß sein.',
      { ...values, budget: formatNumber(messages, logoByteBudget(design)) }
    );
  }
  return t('„{page}“ hätte {bytes} Bytes, HAProxy lädt höchstens {max}. Kürzen Sie die Texte.', values);
}
