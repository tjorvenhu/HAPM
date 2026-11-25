import { describe, it, expect } from 'vitest';
import {
  defaultPageDesign,
  isDefaultDesign,
  parsePageDesign,
  PAGE_MAX_BYTES,
  type PageDesign,
} from '@/lib/haproxy/page-design';
import { designPageSizes, designSizeError } from '@/lib/haproxy/design-pages';
import { errorFiles, renderErrorFile } from '@/lib/haproxy/error-pages';
import { lockPages, renderLockPage } from '@/lib/haproxy/lock-page';
import { CUSTOM_PAGE_STARTER, renderCustomPage } from '@/lib/haproxy/custom-page';
import { renderErrorPage } from '@/ui/static/page';

/**
 * Die drei Arten der Fehlerseiten: die Seite von HAPM, „Selbst gestalten“ und
 * eigenes HTML und CSS. Was hier steht, fiele sonst erst auf einer Maschine
 * auf: eine bestehende Installation, die nach dem Update eine andere Art hat,
 * eine Vorlage, die HAProxy ablehnt, oder eine Passwortabfrage ohne Formular.
 */

function parsed(raw: unknown): PageDesign {
  const result = parsePageDesign(raw);
  if (!result.ok) throw new Error(result.error);
  return result.design;
}

const body = (file: string) => file.slice(file.indexOf('\r\n\r\n') + 4);

const OWN = {
  colors: { accent: '#7a1f3d', background: '#101418', text: '#eef1f4' },
  brand: 'Beispiel GmbH',
  errors: { 503: { title: 'Wartung' } },
};

describe('eine Zeile von vor der Wahl', () => {
  it('ist mit eigenem Design „Selbst gestalten“ und behält ihre Seiten', () => {
    const read = parsed(OWN);
    expect(read.mode).toBe('designed');
    expect(renderErrorFile(503, read)).toContain('<h1>Wartung</h1>');
    expect(read.custom).toEqual({ html: '' });
  });

  it('ist ohne eigenes Design „Standard“, auch mit englischen Vorgabetexten', () => {
    const { mode: _mode, custom: _custom, ...before } = defaultPageDesign();
    expect(parsed(before).mode).toBe('standard');
    expect(isDefaultDesign(parsed(before))).toBe(true);
    expect(parsed({ ...before, locale: 'en' }).mode).toBe('standard');
  });

  it('lehnt eine unbekannte Art ab', () => {
    expect(parsePageDesign({ mode: 'fancy' }).ok).toBe(false);
  });
});

describe('Standard', () => {
  it('schreibt die Seite von HAPM, auch wenn ein Design gespeichert ist', () => {
    const standard = parsed({ ...OWN, mode: 'standard' });
    expect(errorFiles(standard)).toEqual(errorFiles(defaultPageDesign()));
    expect(lockPages(standard)).toEqual(lockPages(defaultPageDesign()));
  });

  it('behält die Felder des Designs für den Weg zurück', () => {
    const standard = parsed({ ...OWN, mode: 'standard' });
    expect(standard.colors.accent).toBe('#7a1f3d');
    expect(parsed(JSON.parse(JSON.stringify(standard)))).toEqual(standard);
  });

  it('folgt der Sprache der Vorgabetexte', () => {
    const english = parsed({ ...OWN, mode: 'standard', locale: 'en' });
    expect(renderErrorFile(503, english)).toContain('<html lang="en">');
    expect(renderErrorFile(503, english)).not.toContain('Wartung');
  });

  it('ist dasselbe wie „Selbst gestalten“ ohne jede Änderung', () => {
    const designed = { ...defaultPageDesign(), mode: 'designed' as const };
    expect(errorFiles(designed)).toEqual(errorFiles(defaultPageDesign()));
  });
});

describe('die Seite von HAPM', () => {
  const html = renderErrorPage(503);

  it('steht in der Schrift des Systems, ohne Serif', () => {
    expect(html).toContain('font:400 1rem/1.6 system-ui,-apple-system');
    expect(html).not.toMatch(/serif'|Times|Instrument/);
    expect(html).not.toMatch(/url\(|@import|<link/);
  });

  it('hat eine dunkle Fassung, aber nur ohne eigene Farben', () => {
    expect(html).toContain('@media(prefers-color-scheme:dark)');
    expect(html).toContain('color-scheme:light dark');
    for (const colors of [{ accent: '#ff0000' }, { background: '#ffffff' }, { text: '#111111' }]) {
      expect(renderErrorPage(503, {}, colors)).not.toContain('prefers-color-scheme');
    }
  });

  it('hellt das Logo von HAPM auf einem dunklen eigenen Grund auf, auf hellem nicht', () => {
    expect(renderErrorPage(503, {}, { background: '#101418' })).toContain('.logo path[fill="#042d20"]{fill:');
    expect(renderErrorPage(503, {}, { background: '#ffffff' })).not.toContain('.logo path[');
  });

  it('nennt den Code sichtbar', () => {
    expect(html).toContain('<p class="code">Fehler <b>503</b></p>');
    expect(renderErrorPage(503, { locale: 'en' })).toContain('<p class="code">Error <b>503</b></p>');
  });
});

describe('eigene HTML-Datei', () => {
  const FILE = '<!doctype html>\r\n<html><head><style>.x{color:red}</style></head><body><p class="x">{{status}} bleibt stehen</p></body></html>';
  const custom = parsed({ mode: 'custom', custom: { html: FILE } });

  it('liefert die Datei unverändert aus, ohne Rahmen und ohne Platzhalter', () => {
    const file = renderErrorFile(503, custom);
    expect(file.startsWith('HTTP/1.1 503 Service Unavailable\r\n')).toBe(true);
    expect(file).toContain('Content-Type: text/html; charset=utf-8');
    const page = body(file);
    expect(page).toBe(`${FILE.replace('\r\n', '\n')}\n`);
    expect(page).toContain('{{status}} bleibt stehen');
    expect(page).not.toContain('noindex');
  });

  it('nimmt für jeden Status dieselbe Datei', () => {
    expect(body(renderErrorFile(404, custom))).toBe(body(renderErrorFile(503, custom)));
    expect(body(renderErrorFile(403, { ...custom, locale: 'en' }))).toBe(body(renderErrorFile(503, custom)));
  });

  it('setzt nichts ein, auch nichts, was nach Markup aussieht', () => {
    expect(renderCustomPage({ html: '<h1>{{title}}</h1>' })).toBe('<h1>{{title}}</h1>\n');
  });

  it('lässt die Passwortabfrage bei der von HAPM', () => {
    expect(lockPages({ ...custom, ...OWN, mode: 'custom' } as PageDesign)).toEqual(lockPages(defaultPageDesign()));
    expect(renderLockPage('ask', custom)).toContain('<form method="post">');
  });

  it('übersteht den Weg durch Prüfung und Datenbank', () => {
    expect(parsed(JSON.parse(JSON.stringify(custom)))).toEqual(custom);
    expect(custom.custom.html).not.toContain('\r');
  });

  it('vergisst ein CSS aus einer früheren Fassung', () => {
    const old = parsed({ mode: 'custom', custom: { html: '<p>x</p>', css: 'p{}' } });
    expect(old.custom).toEqual({ html: '<p>x</p>' });
  });

  it('nimmt die Vorlage, mit der das Formular beginnt', () => {
    const starter = parsed({ mode: 'custom', custom: CUSTOM_PAGE_STARTER });
    expect(starter.custom).toEqual(CUSTOM_PAGE_STARTER);
    expect(designSizeError(starter)).toBeNull();
  });

  it('lehnt nur eine leere Datei ab, alles andere geht so hinaus', () => {
    const check = (html: string) => parsePageDesign({ mode: 'custom', custom: { html } });
    expect(check('  \n ')).toEqual({ ok: false, error: expect.stringContaining('Das HTML ist leer') });
    expect(check('<!DOCTYPE html><html><body>x</body></html>').ok).toBe(true);
    expect(check('nur Text').ok).toBe(true);
  });

  it('hält eine leere Vorlage bei einer anderen Art nicht auf', () => {
    const half = parsed({ mode: 'designed', ...OWN, custom: { html: '' } });
    expect(half.mode).toBe('designed');
    expect(parsePageDesign({ ...half, mode: 'custom' }).ok).toBe(false);
  });

  it('lehnt eine Datei über der Grenze einer Seite gleich ab', () => {
    const result = parsePageDesign({ mode: 'custom', custom: { html: 'x'.repeat(PAGE_MAX_BYTES + 1) } });
    expect(result).toEqual({ ok: false, error: expect.stringContaining('Das HTML hat 15.001 Bytes') });
  });

  it('misst die fertige Datei samt Kopfzeilen', () => {
    const fill = (html: string) => parsed({ mode: 'custom', custom: { html } });
    const frame = designPageSizes(fill('x')).find((size) => size.page.kind === 'error')!.bytes - 1;
    const fits = fill('x'.repeat(PAGE_MAX_BYTES - frame));
    expect(designPageSizes(fits)[0].bytes).toBe(PAGE_MAX_BYTES);
    expect(designSizeError(fits)).toBeNull();

    const over = fill('x'.repeat(PAGE_MAX_BYTES - frame + 1));
    expect(designSizeError(over)).toMatch(/^Als Fehlerseite hätte die Datei 15\.001 Bytes, HAProxy lädt höchstens 15\.000\. Kürzen Sie das HTML\.$/);
  });
});
