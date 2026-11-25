/**
 * Fehlerseiten aus einer eigenen HTML-Datei: die dritte Art neben der Seite von
 * HAPM und dem Design aus Farben, Logo und Texten (`page-design.ts`).
 *
 * ── Die Datei, wie sie ist ──
 *
 * Was der Benutzer eingibt, ist die ganze Datei, und genau sie geht hinaus:
 * für jeden Status dieselbe, ohne Platzhalter, ohne Rahmen, ohne einen Titel
 * oder `noindex` von HAPM. CSS steht, wenn gewünscht, in einem `<style>` der
 * Datei selbst. Eine frühere Fassung setzte Status und Texte über Platzhalter
 * ein und legte Doctype und Kopf um den Inhalt. Gewünscht war das Gegenteil:
 * wer eigenes HTML hinterlegt, will genau dieses ausgeliefert sehen.
 *
 * Den Zeichensatz nennt ohnehin der Kopf der Antwort, den HAPM vor die Datei
 * schreibt (`Content-Type: text/html; charset=utf-8`), Umlaute stimmen also
 * auch ohne `<meta charset>`.
 *
 * ── Was HAPM prüft ──
 *
 * Nur, was HAProxy ablehnte: die Größe (`designSizeError`), dazu dass die
 * Datei nicht leer ist. Das HTML wird nicht gedeutet, auch ein Skript bleibt
 * stehen: wer HAPM bedient, bestimmt ohnehin, was der Proxy ausliefert.
 *
 * Rein und ohne Umgebung, wie `page-design.ts`.
 */

export interface CustomPage {
  /** Die ganze HTML-Datei. */
  html: string;
}

/**
 * Womit das Formular das Feld füllt, wenn es beim ersten Wechsel auf diese Art
 * leer ist: eine vollständige, kleine Seite zum Umbauen.
 */
export const CUSTOM_PAGE_STARTER: CustomPage = {
  html: [
    '<!doctype html>',
    '<html lang="de">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  <title>Nicht erreichbar</title>',
    '  <style>',
    '    body {',
    '      margin: 0;',
    '      min-height: 100vh;',
    '      display: grid;',
    '      place-items: center;',
    '      font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;',
    '      background: #f5f7f6;',
    '      color: #0f1412;',
    '    }',
    '    main { max-width: 32rem; padding: 2rem; text-align: center; }',
    '    h1 { margin: 0 0 0.5rem; font-size: 1.75rem; }',
    '    p { line-height: 1.6; color: #4a5551; }',
    '  </style>',
    '</head>',
    '<body>',
    '  <main>',
    '    <h1>Diese Seite ist gerade nicht erreichbar</h1>',
    '    <p>Bitte versuchen Sie es in einigen Minuten noch einmal.</p>',
    '  </main>',
    '</body>',
    '</html>',
  ].join('\n'),
};

/**
 * Was aus dem Feld gespeichert wird: Zeilenenden als LF, ohne Steuerzeichen
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

/** Die Seite, für jeden Status dieselbe: die Datei, wie sie eingegeben wurde. */
export function renderCustomPage(page: CustomPage): string {
  return `${page.html}\n`;
}
