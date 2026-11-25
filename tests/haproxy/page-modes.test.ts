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
    expect(read.custom).toEqual({ html: '', css: '' });
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

describe('eigenes HTML und CSS', () => {
  const custom = parsed({
    mode: 'custom',
    custom: { html: '<div class="x">{{ status }}: {{title}}</div>\r\n<p>{{text}}</p>', css: '.x{color:red}' },
  });

  it('setzt Status, Überschrift und Text ein, in einem Rahmen von HAPM', () => {
    const file = renderErrorFile(503, custom);
    expect(file.startsWith('HTTP/1.1 503 Service Unavailable\r\n')).toBe(true);
    const page = body(file);
    expect(page.startsWith('<!doctype html><html lang="de"><head><meta charset="utf-8">')).toBe(true);
    expect(page).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(page).toContain('<title>Gerade nicht erreichbar (503)</title>');
    expect(page).toContain('<style>.x{color:red}</style>');
    expect(page).toContain('<div class="x">503: Gerade nicht erreichbar</div>\n<p>Die Seite ist im Moment');
    expect(page.includes('\r')).toBe(false);
  });

  it('nimmt für jeden Status dessen Texte, für die 404 die des Proxys', () => {
    expect(renderErrorFile(404, custom)).toContain('404: Seite nicht gefunden');
    expect(renderErrorFile(404, custom)).toContain('Unter dieser Adresse ist nichts eingerichtet.');
    expect(renderErrorFile(403, { ...custom, locale: 'en' })).toContain('<html lang="en">');
  });

  it('maskiert, was es einsetzt', () => {
    const page = renderCustomPage(
      { html: '<h1>{{title}}</h1>', css: '' },
      { status: '503', title: '<script>"&', text: '' },
      'de'
    );
    expect(page).toContain('<h1>&lt;script&gt;&quot;&amp;</h1>');
    expect(page).not.toContain('<style>');
  });

  it('lässt die Passwortabfrage bei der von HAPM', () => {
    expect(lockPages({ ...custom, ...OWN, mode: 'custom' } as PageDesign)).toEqual(lockPages(defaultPageDesign()));
    expect(renderLockPage('ask', custom)).toContain('<form method="post">');
  });

  it('übersteht den Weg durch Prüfung und Datenbank', () => {
    expect(parsed(JSON.parse(JSON.stringify(custom)))).toEqual(custom);
    expect(custom.custom.html).not.toContain('\r');
  });

  it('nimmt die Vorlage, mit der das Formular beginnt', () => {
    const starter = parsed({ mode: 'custom', custom: CUSTOM_PAGE_STARTER });
    expect(starter.custom).toEqual(CUSTOM_PAGE_STARTER);
    expect(designSizeError(starter)).toBeNull();
  });

  it('lehnt ab, was die Seite kaputt machte', () => {
    const reject = (html: string, css = '') => parsePageDesign({ mode: 'custom', custom: { html, css } });
    expect(reject('<!DOCTYPE html><p>x</p>')).toEqual({ ok: false, error: expect.stringContaining('Inhalt von <body>') });
    expect(reject('<html><p>x</p></html>').ok).toBe(false);
    expect(reject('<BODY>x</BODY>').ok).toBe(false);
    expect(reject('<p>{{status}} {{code}}</p>')).toEqual({
      ok: false,
      error: 'Den Platzhalter {{code}} gibt es nicht. Erlaubt sind {{status}}, {{title}}, {{text}}.',
    });
    expect(reject('<p>x</p>', 'p{}</STYLE><script>')).toEqual({ ok: false, error: expect.stringContaining('</style>') });
    expect(reject('  \n ')).toEqual({ ok: false, error: expect.stringContaining('Das HTML ist leer') });
    // Ein Wort mit „body“ darin ist kein Rahmen.
    expect(reject('<p>nobody <bodyguard></p>').ok).toBe(true);
  });

  it('hält eine halbe Vorlage bei einer anderen Art nicht auf', () => {
    const half = parsed({ mode: 'designed', ...OWN, custom: { html: '{{unbekannt}}', css: '</style>' } });
    expect(half.mode).toBe('designed');
    expect(parsePageDesign({ ...half, mode: 'custom' }).ok).toBe(false);
  });

  it('lehnt ein Feld über der Grenze einer Seite gleich ab', () => {
    const result = parsePageDesign({ mode: 'custom', custom: { html: 'x'.repeat(PAGE_MAX_BYTES + 1), css: '' } });
    expect(result).toEqual({ ok: false, error: expect.stringContaining('Das HTML hat 15.001 Bytes') });
    const css = parsePageDesign({ mode: 'designed', custom: { html: '', css: 'ü'.repeat(PAGE_MAX_BYTES / 2 + 1) } }, 'en');
    expect(css).toEqual({ ok: false, error: 'The CSS has 15,002 bytes. A whole page may have at most 15,000 bytes.' });
  });

  it('misst die fertige Datei und nennt HTML und CSS, wenn sie zu groß wird', () => {
    const fill = (html: string) => parsed({ mode: 'custom', custom: { html, css: '' } });
    // Die Passwortabfrage bleibt die von HAPM und ist hier klein. Gemessen wird
    // die größte Fehlerseite: ihr Text steht schon in `frame`, der Rest ist Platz.
    const frame = designPageSizes(fill('{{text}}')).find((size) => size.page.kind === 'error')!.bytes;
    const fits = fill(`{{text}}${'x'.repeat(PAGE_MAX_BYTES - frame)}`);
    expect(designPageSizes(fits)[0].bytes).toBe(PAGE_MAX_BYTES);
    expect(designSizeError(fits)).toBeNull();

    const over = fill(`{{text}}${'x'.repeat(PAGE_MAX_BYTES - frame + 1)}`);
    expect(designSizeError(over)).toMatch(/^Mit diesem HTML und CSS hätte „5\d\d · .+“ 15\.001 Bytes, HAProxy lädt höchstens 15\.000\. Kürzen Sie HTML oder CSS\.$/);
  });
});
