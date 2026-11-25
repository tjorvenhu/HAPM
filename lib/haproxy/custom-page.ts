/**
 * Fehlerseiten aus eigenem HTML und CSS: die dritte Art neben der Seite von
 * HAPM und dem Design aus Farben, Logo und Texten (`page-design.ts`).
 *
 * ── Was der Benutzer gibt und was HAPM setzt ──
 *
 * Das HTML ist der Inhalt von `<body>`, das CSS der Inhalt eines `<style>`.
 * Den Rahmen setzt HAPM: Doctype, `<html lang>`, Zeichensatz, Viewport,
 * `noindex` und den Titel im Tab. So stimmt der Zeichensatz immer (eine
 * Fehlerdatei ohne ihn zeigte Umlaute je nach Browser falsch), und keine Seite
 * landet in einem Suchindex. Wer ein ganzes Dokument einfügt, bekommt eine
 * Meldung statt zweier verschachtelter.
 *
 * ── Eine Vorlage für jeden Status ──
 *
 * Status, Überschrift und Text kommen über Platzhalter hinein (`{{status}}`,
 * `{{title}}`, `{{text}}`), maskiert, mit den Texten von HAPM in der Sprache
 * der Vorgabetexte. Die eigenen Texte aus „Selbst gestalten“ gelten hier nicht:
 * sie gehören zu der Art, in der man sie eingibt. Ersetzt wird nur im HTML.
 *
 * ── Was HAPM nicht prüft ──
 *
 * Das HTML wird nicht gedeutet, auch ein Skript bleibt stehen: wer HAPM
 * bedient, bestimmt ohnehin, was der Proxy ausliefert. Ein Bild oder eine
 * Schrift von einer anderen Adresse lädt der Browser des Besuchers nach. Geprüft
 * wird, was die Datei kaputt machte oder HAProxy ablehnte: `</style>` im CSS,
 * ein zweites Dokument im HTML, die Größe (`designSizeError`).
 *
 * Rein und ohne Umgebung, wie `page-design.ts`.
 */

import { escapeHtml } from '@/ui/static/page';
import type { Locale } from '@/lib/i18n';

export interface CustomPage {
  /** Der Inhalt von `<body>`. */
  html: string;
  /** Der Inhalt von `<style>`. Leer heißt: kein `<style>`. */
  css: string;
}

export const CUSTOM_PAGE_PLACEHOLDERS = ['status', 'title', 'text'] as const;

export type CustomPlaceholder = (typeof CUSTOM_PAGE_PLACEHOLDERS)[number];

/** Jedes `{{…}}`, auch mit Leerzeichen innen. Der Name kommt in die erste Gruppe. */
export const PLACEHOLDER_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g;

/**
 * Womit das Formular die Felder füllt, wenn sie beim ersten Wechsel auf diese
 * Art leer sind. Ohne Text in einer Sprache: alles Lesbare kommt aus den
 * Platzhaltern.
 */
export const CUSTOM_PAGE_STARTER: CustomPage = {
  html: ['<main>', '  <p class="code">{{status}}</p>', '  <h1>{{title}}</h1>', '  <p>{{text}}</p>', '</main>'].join('\n'),
  css: [
    'body {',
    '  margin: 0;',
    '  min-height: 100vh;',
    '  display: grid;',
    '  place-items: center;',
    '  font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;',
    '  background: #f5f7f6;',
    '  color: #0f1412;',
    '}',
    'main { max-width: 32rem; padding: 2rem; text-align: center; }',
    '.code { margin: 0; font-size: 4rem; font-weight: 700; color: #1a5c4c; }',
    'h1 { margin: 0.5rem 0; font-size: 1.75rem; }',
    'p { line-height: 1.6; }',
  ].join('\n'),
};

/**
 * Was aus einem Feld gespeichert wird: Zeilenenden als LF, ohne Steuerzeichen
 * außer Tab und Zeilenende, ohne Leerraum am Anfang und Ende. Die Fehlerdatei
 * trägt CRLF nur in ihren Kopfzeilen; ein CR im Rumpf ergäbe je nach Weg auf die
 * Platte eine andere Prüfsumme.
 */
export function cleanCustomSource(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
}

/** Die Platzhalter im HTML, die es nicht gibt, je einmal. */
export function unknownPlaceholders(html: string): string[] {
  const unknown = new Set<string>();
  for (const match of html.matchAll(PLACEHOLDER_PATTERN)) {
    if (!(CUSTOM_PAGE_PLACEHOLDERS as readonly string[]).includes(match[1])) unknown.add(match[0]);
  }
  return [...unknown];
}

/** Ein Rahmen, den HAPM selbst setzt: ein zweiter stünde mitten in `<body>`. */
export function hasDocumentFrame(html: string): boolean {
  return /<\s*\/?\s*(?:!doctype|html|head|body)\b/i.test(html);
}

/** Das CSS endete an dieser Stelle, und der Rest stünde als Text in der Seite. */
export function closesStyle(css: string): boolean {
  return /<\/style/i.test(css);
}

/**
 * Die Seite zu einem Status. Die Werte sind schon in der Sprache der Seite;
 * maskiert wird hier.
 */
export function renderCustomPage(
  page: CustomPage,
  values: Record<CustomPlaceholder, string>,
  locale: Locale
): string {
  const body = page.html.replace(PLACEHOLDER_PATTERN, (whole, name: string) =>
    Object.hasOwn(values, name) ? escapeHtml(values[name as CustomPlaceholder]) : whole
  );
  return (
    '<!doctype html>' +
    `<html lang="${escapeHtml(locale)}">` +
    '<head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow">' +
    `<title>${escapeHtml(`${values.title} (${values.status})`)}</title>` +
    (page.css ? `<style>${page.css}</style>` : '') +
    '</head>' +
    `<body>${body}</body>` +
    '</html>\n'
  );
}
