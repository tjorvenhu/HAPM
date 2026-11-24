import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { STATIC_LOGO_SVG } from '@/ui/static/logo';
import { renderErrorPage, renderStaticPage, staticPasswordForm } from '@/ui/static/page';

/**
 * Das Logo steht zweimal im Projekt: als Datei für die Oberfläche und als Text
 * für die Seiten, die HAProxy selbst ausliefert (Fehlerseiten, Passwortabfrage).
 * Wer die Datei tauscht, muss den Text nachziehen, sonst zeigt der Proxy ein
 * anderes Logo als die Oberfläche.
 */
describe('STATIC_LOGO_SVG', () => {
  const file = readFileSync('public/hapm-logo.svg', 'utf8').trim();

  it('ist dieselbe Zeichnung wie public/hapm-logo.svg', () => {
    const paths = (svg: string) => [...svg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
    expect(paths(STATIC_LOGO_SVG)).toEqual(paths(file));
    expect(paths(file).length).toBe(3);
  });

  it('trägt den Namen von HAPM, und die Seiten zeigen kein anderes Logo', () => {
    expect(STATIC_LOGO_SVG).toContain('aria-label="HAPM"');
    const pages = [
      renderErrorPage(503),
      renderStaticPage({
        title: 'Geschützter Bereich',
        body: staticPasswordForm({ field: 'p', label: 'Passwort', submit: 'Öffnen' }),
      }),
    ];
    for (const page of pages) {
      // Genau ein Bild mit Namen, und es ist dieses. Nachgeladen wird nichts.
      expect(page).toContain(STATIC_LOGO_SVG);
      expect(page.match(/role="img"/g)?.length).toBe(1);
      expect(page.match(/aria-label="(?!Startseite")[^"]*"/g)).toEqual(['aria-label="HAPM"']);
      expect(page).not.toMatch(/<img\b|url\(/);
    }
  });

  it('lässt die Seiten im Antwortpuffer von HAProxy Platz', () => {
    // 16 KB fasst der Puffer samt Kopfzeilen. Die Grenze der Seiten steht bei 11 KB.
    expect(Buffer.byteLength(renderErrorPage(503))).toBeLessThan(11_000);
    expect(Buffer.byteLength(STATIC_LOGO_SVG)).toBeLessThan(4_500);
  });
});
