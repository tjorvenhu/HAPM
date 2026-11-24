import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  base64ToBytes,
  bytesToBase64,
  defaultPageDesign,
  designTheme,
  isDefaultDesign,
  logoDataUri,
  parsePageDesign,
  sniffLogoType,
  DESIGN_TEXT_LIMITS,
  PAGE_MAX_BYTES,
  type PageDesign,
} from '@/lib/haproxy/page-design';
import {
  DESIGN_PAGES,
  designPageFile,
  designPageHtml,
  designPageSizes,
  designSizeError,
  logoByteBudget,
} from '@/lib/haproxy/design-pages';
import { errorFiles, renderErrorFile } from '@/lib/haproxy/error-pages';
import { lockPages, renderLockPage } from '@/lib/haproxy/lock-page';
import { renderErrorPage, renderStaticPage } from '@/ui/static/page';

/**
 * Das Design der Seiten, die HAProxy selbst ausliefert.
 *
 * Drei Dinge, die sonst erst auf einer Maschine auffallen:
 *  - Die Vorgabe muss Byte für Byte die Seite von vorher ergeben. Sonst gälte
 *    jede bestehende Installation nach dem Update als „Andere Seite“, und der
 *    nächste Klick ersetzte womöglich eine Seite von Hand.
 *  - Was ein Benutzer eintippt, landet in einer Seite, die HAProxy jedem
 *    Besucher zeigt: maskiert, Farben nur in der einen Form, ein Logo nur als
 *    eingebettetes Bild.
 *  - Eine zu große Seite nimmt HAProxy an und beantwortet sie mit 500
 *    (Passwortabfrage) oder lehnt die ganze Konfiguration ab (Fehlerdatei).
 */

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Die Prüfsummen der Seiten vor dem Design, gerechnet mit dem Stand aus
 * `git show HEAD:…` (ui/static/page.ts, lib/haproxy/error-pages.ts,
 * lib/haproxy/lock-page.ts) vor dem Umbau. Ändert sich die Vorlage absichtlich,
 * ändern sich diese Zahlen mit, und jede Installation sieht ihre Dateien danach
 * als „Andere Seite“. Das ist dann eine Entscheidung, kein Versehen.
 */
const BEFORE_DESIGN: Record<string, string> = {
  'error-400': 'b763f35d1aced1aaba9d534b1211bd2b00f2efa9f92366a33a037c9c9cac9f80',
  'error-401': '9369781264a80c04467ba8cf7c28f382c228ca7cfba1cbc184a8fbd6f4b3c4b9',
  'error-403': 'a8aa339c4f115395d871771cb0c3d09c77fdaf25ea95698cd30c70b7d588be2d',
  'error-404': '9c263ffcf2c7bd2f1e120928160a212a62a64c723cf32155c35842c16e1270f3',
  'error-405': '18f3f19b55a8c2b6f807d008bbf7124b9acf154e3572789d134c6db9c2ad42fc',
  'error-408': '13aec7404d52bfed2e3586d1d22ab860cd9a55d4657dc050bf8dbeab7059fb49',
  'error-410': '0d038d529bc0d8d275e2519c8e4c6a29acd33ea1c0ea0f6c8133c8cd0a08f9f2',
  'error-413': 'c1241bbdb30d27100c00f5385f6bee0564f48f0fd7b82ba448faf87e657b0a02',
  'error-429': 'dd73605a8ea9aaa577e67f40b0627ca5958ca7617ecce47ee46f49628c16fa51',
  'error-500': 'd1d82662fa2cee52034972aea2ea6edff57485f91c8d766c849ee39912a71db3',
  'error-501': '22e3d545620fbb0451955f9e62e94a038fc89124fdbdfe1db15334edbacfb407',
  'error-502': '742a0c0292209688ccfd2769cd4c48df91cb76d7be38a66183aee06774331ce5',
  'error-503': '332cfdbdbac9c4e8d80463645ae382a3544cc1318988878ae01fe8e0a0734958',
  'error-504': '011a56773185f44c38532005d2389832750f1ab794d81e2ec87bebba51ea7651',
  'lock.html': '387d3dd9437c38072b9473162d36565e5a6abc2a685a501a8e8bc799ee7779b2',
  'lock-wrong.html': '8b78b721d49cc603492f13e6b2c46c0af5321006dbf7168568c418b563849d4f',
  'lock-throttled.html': '7e1b565db6c3951b2466d364aacf32da5dec0a53e54e98936201da50664ddb2a',
};

function digests(design?: PageDesign): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of errorFiles(design)) out[`error-${file.status}`] = sha256(file.content);
  for (const page of lockPages(design)) out[page.file] = sha256(page.html);
  return out;
}

function parsed(raw: unknown): PageDesign {
  const result = parsePageDesign(raw);
  if (!result.ok) throw new Error(result.error);
  return result.design;
}

function design(over: Partial<PageDesign>): PageDesign {
  return { ...defaultPageDesign(), ...over };
}

/** Ein PNG aus Signatur und Füllung. Für `sniffLogoType` reicht der Anfang. */
function png(size: number): string {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let i = 8; i < size; i++) bytes[i] = (i * 31) % 256;
  return bytesToBase64(bytes);
}

const svg = (markup: string) => bytesToBase64(new TextEncoder().encode(markup));

describe('die Vorgabe', () => {
  it('ergibt Byte für Byte die Seiten von vor dem Design', () => {
    expect(digests(defaultPageDesign())).toEqual(BEFORE_DESIGN);
  });

  it('auch ohne Angabe, also mit dem Design, das im Prozess gilt', () => {
    expect(digests()).toEqual(BEFORE_DESIGN);
  });

  it('auch nach dem Weg durch die Prüfung und die Datenbank', () => {
    // Was gespeichert und wieder gelesen wurde, trägt Metadaten der Zeile mit.
    const stored = { ...JSON.parse(JSON.stringify(defaultPageDesign())), $id: 'main', $createdAt: 'x' };
    const read = parsed(stored);
    expect(isDefaultDesign(read)).toBe(true);
    expect(digests(read)).toEqual(BEFORE_DESIGN);
  });

  it('auch wenn ein Text genau der Vorgabe entspricht', () => {
    const same = parsed({ errors: { 503: { title: 'Gerade nicht erreichbar' } } });
    expect(sha256(renderErrorFile(503, same))).toBe(BEFORE_DESIGN['error-503']);
  });
});

/**
 * Die Prüfsummen der englischen Vorgabe. Sie hängen an den Einträgen unter
 * `lib/i18n/en/` (fast alle in `mail.ts`, „Passwort", „Zurück", „Erneut
 * versuchen" und „Das Passwort stimmt nicht." stehen in `common.ts`, `auth.ts`,
 * „Seite nicht gefunden" in `shell.ts`): wer dort einen Text der Seiten ändert, ändert diese
 * Zahlen mit, und jede englische Installation sieht ihre Dateien danach als
 * „Andere Seite“.
 */
const ENGLISH: Record<string, string> = {
  'error-400': '558548d95f250fbcce01becfdf45597c844329d4d0381c12c24fea3eba2ba164',
  'error-401': 'b932a0067bde46764e2d0ad594767b24a0a6f49d7da2afcc05a8ef380e6857ca',
  'error-403': 'faa4166c0c575b76a11dc9308e003b6cb311346c05b4c73cb91c5a56204f0e5b',
  'error-404': 'c58f8f51565cd9e5e7100b26ad3ac041205b33af37a4ee5987b9dbcafb34989d',
  'error-405': 'a620b6a845dcea29bfb86b76a8093d68dc134637569d2abcc4115bc3980e5c95',
  'error-408': 'dc815fb5a27e7ede6befc5d715a27280bbb5f32bbc9d0b2907f56841f108074a',
  'error-410': 'cbc21d9cc76ef01aedd27ed0529845b7bb03b0ab7207c5bf5c9f263255bdf6f1',
  'error-413': 'c146572106cff522a931db9bf3ba7d1e02b3050a7b6e88451914d2476c17bfbd',
  'error-429': '829b3f07a7f14cca8f96c4fcbcd7ba3b7b3d123119b1d8f476ce0a0752d73e6c',
  'error-500': '295adffa25c153b17f96ca5e346beeaa708a7a86a2b12b174889e3c45326c3cb',
  'error-501': 'a8fa0e0b5afccb423b423cf10cc331ca8a4324c7fba9970c9f5bafe069e2c0b2',
  'error-502': 'a6df7454aaa0f69d5b90009318f3013dc40e6e8ef5ef09f02d4959fefc1b65d7',
  'error-503': '9d87a81aeedad5d3903ddb4609796470562f1158d9020e77e5d105629fcdb402',
  'error-504': '7eb88c6d3abeda6d8d69f05f6d0169a94da4eef1ff31ded171e454caa8bd9d7e',
  'lock.html': '4a24980cace2ed8ff934e8f34276cc0c615f070fa80cdb91389cea161315a785',
  'lock-wrong.html': 'e53c2ee3c132b2d9358deca589d44071c660577ef7afefd9d2f9697d276a7af2',
  'lock-throttled.html': '52f91b291a7053f75542bb07828c2154b9e20962417077d1fdeb2a40428ec880',
};

describe('die Sprache der Vorgabetexte', () => {
  const english = design({ locale: 'en' });

  it('ist ohne Wahl Deutsch, auch für eine Zeile von vor der Wahl', () => {
    expect(defaultPageDesign().locale).toBe('de');
    const { locale: _locale, ...before } = defaultPageDesign();
    expect(parsed(before).locale).toBe('de');
    expect(isDefaultDesign(parsed(before))).toBe(true);
    expect(digests(parsed({ ...before, locale: 'de' }))).toEqual(BEFORE_DESIGN);
  });

  it('ergibt Byte für Byte die englischen Seiten', () => {
    expect(digests(english)).toEqual(ENGLISH);
  });

  it('übersteht den Weg durch Prüfung und Datenbank', () => {
    const read = parsed(JSON.parse(JSON.stringify(english)));
    expect(read.locale).toBe('en');
    expect(isDefaultDesign(read)).toBe(false);
    expect(digests(read)).toEqual(ENGLISH);
  });

  it('lehnt eine andere Sprache ab', () => {
    expect(parsePageDesign({ locale: 'fr' }).ok).toBe(false);
  });

  it('setzt <html lang> und die Texte von HAPM auf Englisch', () => {
    const file = renderErrorFile(503, english);
    expect(file).toContain('<html lang="en">');
    expect(file).toContain('<h1>Temporarily unavailable</h1>');
    expect(file).toContain('Try again');
    expect(file).toContain('aria-label="Homepage"');
    expect(file).not.toMatch(/Erneut|Zurück|Startseite|erreichbar/);
    expect(renderErrorFile(404, english)).toContain('Nothing is set up at this address.');

    const lock = renderLockPage('throttled', english);
    expect(lock).toContain('<html lang="en">');
    expect(lock).toContain('Too many attempts. Please try again in ten minutes.');
    expect(renderLockPage('ask', english)).toContain('<label for="pw">Password</label>');
  });

  it('lässt eigene Texte, wie sie sind', () => {
    const custom = parsed({ locale: 'en', errors: { 503: { title: 'Wartung' } }, lock: { submit: 'Weiter' } });
    expect(renderErrorFile(503, custom)).toContain('<h1>Wartung</h1>');
    expect(renderErrorFile(503, custom)).toContain('Please try again shortly.');
    expect(renderLockPage('ask', custom)).toContain('Weiter');
    expect(renderLockPage('ask', custom)).toContain('This page is protected by a password.');
  });

  it('bleibt unter der Grenze und lässt Platz für ein Logo', () => {
    expect(designSizeError(english)).toBeNull();
    expect(designPageSizes(english)[0].bytes).toBeLessThan(PAGE_MAX_BYTES);
    expect(logoByteBudget(english)).toBeGreaterThan(5_000);
  });
});

describe('parsePageDesign', () => {
  it('nennt den Grund in der Sprache der Oberfläche', () => {
    expect(parsePageDesign({ colors: { accent: 'rot' } }, 'en')).toEqual({
      ok: false,
      error: 'The accent color is not a color in the form #rrggbb.',
    });
  });

  it('nimmt Farben nur als #rrggbb und schreibt sie klein', () => {
    expect(parsed({ colors: { accent: '#A1B2C3' } }).colors.accent).toBe('#a1b2c3');
    for (const bad of ['#fff', 'red', '#12345g', '#000000;}body{x:y', 'rgb(0,0,0)', ' #000000', 7]) {
      const result = parsePageDesign({ colors: { accent: bad } });
      expect(result.ok, String(bad)).toBe(false);
    }
  });

  it('liest leer und null als Vorgabe', () => {
    const read = parsed({ colors: { accent: '', background: null } });
    expect(read.colors).toEqual({ accent: null, background: null, text: null });
  });

  it('macht aus Umbrüchen und Steuerzeichen Leerzeichen', () => {
    const read = parsed({ errors: { 503: { title: ' Wartung\r\n\u0000heute ' } } });
    expect(read.errors[503]).toEqual({ title: 'Wartung heute' });
  });

  it('lehnt einen leeren Text ab, statt ihn als Vorgabe zu lesen', () => {
    const result = parsePageDesign({ lock: { title: '   ' } });
    expect(result).toEqual({ ok: false, error: expect.stringContaining('darf nicht leer sein') });
  });

  it('hält die Längen ein', () => {
    expect(parsePageDesign({ errors: { 404: { title: 'x'.repeat(DESIGN_TEXT_LIMITS.title + 1) } } }).ok).toBe(false);
    expect(parsePageDesign({ lock: { submit: 'x'.repeat(DESIGN_TEXT_LIMITS.submit + 1) } }).ok).toBe(false);
    expect(parsePageDesign({ footer: 'x'.repeat(DESIGN_TEXT_LIMITS.footer + 1) }).ok).toBe(false);
    expect(parsePageDesign({ brand: 'x'.repeat(DESIGN_TEXT_LIMITS.brand) }).ok).toBe(true);
  });

  it('kennt nur Status, für die es eine Seite gibt', () => {
    expect(parsePageDesign({ errors: { 418: { title: 'Teekanne' } } }).ok).toBe(false);
    expect(parsePageDesign({ errors: { __proto__x: {} } }).ok).toBe(false);
  });

  it('bestimmt den Typ des Logos am Inhalt, nicht an der Angabe', () => {
    const read = parsed({ logo: { kind: 'custom', mime: 'image/svg+xml', data: png(64) } });
    expect(read.logo).toEqual({ kind: 'custom', mime: 'image/png', data: png(64) });
  });

  it('lehnt eine Datei ab, die kein erlaubtes Bild ist', () => {
    const gif = bytesToBase64(new TextEncoder().encode('GIF89a......'));
    const html = svg('<html><script>alert(1)</script></html>');
    for (const data of [gif, html, 'kein base64!', '']) {
      expect(parsePageDesign({ logo: { kind: 'custom', data } }).ok, data).toBe(false);
    }
  });

  it('lehnt ein SVG mit eigenen Entitäten ab', () => {
    const entity = svg('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>');
    expect(sniffLogoType(base64ToBytes(entity)!)).toBeNull();
    const plain = svg('<?xml version="1.0"?>\n<!-- Logo -->\n<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(sniffLogoType(base64ToBytes(plain)!)).toBe('image/svg+xml');
  });

  it('lehnt ein Logo ab, das in keine Seite passen kann, und nennt die Höchstgröße', () => {
    const result = parsePageDesign({ logo: { kind: 'custom', data: png(PAGE_MAX_BYTES + 3) } });
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining(`höchstens ${PAGE_MAX_BYTES.toLocaleString('de-DE')} Bytes`),
    });
  });

  it('ist idempotent', () => {
    const raw = {
      colors: { accent: '#FF0000', background: '#101010', text: null },
      logo: { kind: 'custom', data: png(100) },
      brand: ' Beispiel ',
      footer: 'Kontakt: it@example.org',
      errors: { 503: { text: 'Wartung.' } },
      lock: { title: 'Vorschau', subtitle: null, submit: 'Weiter' },
    };
    const once = parsed(raw);
    expect(parsed(JSON.parse(JSON.stringify(once)))).toEqual(once);
    expect(isDefaultDesign(once)).toBe(false);
  });
});

describe('rendern mit eigenem Design', () => {
  const custom = parsed({
    colors: { accent: '#c0ffee', background: '#101820', text: '#f0f0f0' },
    logo: { kind: 'custom', data: png(40) },
    brand: 'Beispiel GmbH',
    footer: 'Kontakt: it@example.org',
    errors: { 503: { title: 'Wartung', text: 'Wir sind gleich zurück.' } },
    lock: { title: 'Vorschau', subtitle: 'Nur für Eingeladene.', submit: 'Weiter' },
  });

  it('setzt Farben, Texte, Name und Fußzeile in die Fehlerseite', () => {
    const file = renderErrorFile(503, custom);
    expect(file.startsWith('HTTP/1.1 503 Service Unavailable\r\n')).toBe(true);
    expect(file).not.toMatch(/Content-Length/i);
    expect(file).toContain('--accent:#c0ffee');
    expect(file).toContain('--bg:#101820');
    expect(file).toContain('--text:#f0f0f0');
    expect(file).toContain('<h1>Wartung</h1>');
    expect(file).toContain('Wir sind gleich zurück.');
    expect(file).toContain('Beispiel GmbH');
    expect(file).toContain('<p class="foot">Kontakt: it@example.org</p>');
    expect(file).toContain('<img src="data:image/png;base64,');
  });

  it('lässt die anderen Fälle bei ihrem Text', () => {
    expect(renderErrorFile(404, custom)).toContain('nichts eingerichtet');
  });

  it('setzt Überschrift, Text und Knopf in die Passwortabfrage', () => {
    const html = renderLockPage('ask', custom);
    expect(html).toContain('<h1>Vorschau</h1>');
    expect(html).toContain('Nur für Eingeladene.');
    expect(html).toContain('Weiter');
    expect(html).toContain('Kontakt: it@example.org');
    // Der Hinweis der zweiten Fassung bleibt.
    expect(renderLockPage('wrong', custom)).toContain('Das Passwort stimmt nicht.');
  });

  it('wählt die Schrift auf dem Knopf nach dem Kontrast', () => {
    expect(renderErrorFile(503, parsed({ colors: { accent: '#ffee00' } }))).toContain('color:#0f0f0f');
    expect(renderErrorFile(503, parsed({ colors: { accent: '#202060' } }))).toMatch(/background:var\(--accent\);color:#fff/);
  });

  it('zeigt ohne Logo keines, auch nicht das von HAPM', () => {
    const none = parsed({ logo: { kind: 'none' } });
    const html = designPageHtml(DESIGN_PAGES[0], none);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<div class="logo">');
    expect(renderLockPage('ask', none)).not.toContain('class="logo"');
  });
});

describe('Maskierung', () => {
  const evil = '<script>alert("x")</script>&';

  it('maskiert jeden Text, der vom Benutzer kommt', () => {
    const read = parsed({
      brand: evil,
      footer: evil,
      errors: { 503: { title: evil, text: evil } },
      lock: { title: evil, subtitle: evil, submit: evil },
    });
    for (const html of [renderErrorFile(503, read), renderLockPage('ask', read)]) {
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;');
    }
  });

  it('setzt ein SVG nie als Markup in die Seite, nur als Bild', () => {
    const markup =
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script>' +
      '<a href="javascript:x">"\'&lt;</a></svg>';
    const read = parsed({ logo: { kind: 'custom', data: svg(markup) } });
    const html = renderErrorFile(503, read);
    expect(html).not.toContain('onload="');
    expect(html).not.toContain('<script>');
    expect(html).toMatch(/<img src="data:image\/svg\+xml;(?:charset=utf-8,|base64,)[^"]*"/);
  });

  it('nimmt im Baustein nur eingebettete Bilder und nur gültige Farben', () => {
    const html = renderErrorPage(503, {}, {
      logo: { src: 'https://example.org/logo.png' },
      accent: 'red;}body{display:none',
    });
    expect(html).not.toContain('example.org/logo.png');
    expect(html).not.toContain('display:none');
    expect(renderStaticPage({ title: 'x' }, { logo: { src: 'javascript:alert(1)' } })).not.toContain('javascript:');
  });
});

describe('Data-URI des Logos', () => {
  it('nimmt für ein SVG die kürzere Fassung, und beide sind ein gültiges Attribut', () => {
    const markup = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>';
    const uri = logoDataUri({ mime: 'image/svg+xml', data: svg(markup) });
    expect(uri.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    expect(uri).not.toMatch(/["<>&]/);
    expect(decodeURIComponent(uri.slice(uri.indexOf(',') + 1))).toBe(markup);
  });

  it('lässt ein Rasterbild als Base64', () => {
    expect(logoDataUri({ mime: 'image/png', data: png(20) })).toBe(`data:image/png;base64,${png(20)}`);
  });

  it('gibt dem Baustein das Logo von HAPM, wenn keines gewählt ist', () => {
    expect('logo' in designTheme(defaultPageDesign())).toBe(false);
    expect(designTheme(parsed({ logo: { kind: 'none' } })).logo).toBeNull();
  });
});

describe('die Größe', () => {
  it('lässt mit der Vorgabe Platz für ein Logo', () => {
    expect(designSizeError(defaultPageDesign())).toBeNull();
    expect(logoByteBudget(defaultPageDesign())).toBeGreaterThan(5_000);
  });

  it('passt mit jedem Text in voller Länge und dem Logo von HAPM', () => {
    // Zwei Bytes je Zeichen, wie ein Text aus Umlauten.
    const long = (max: number) => 'ü'.repeat(max);
    const errors = Object.fromEntries(
      DESIGN_PAGES.filter((page) => page.kind === 'error').map((page) => [
        page.kind === 'error' ? page.status : 0,
        { title: long(DESIGN_TEXT_LIMITS.title), text: long(DESIGN_TEXT_LIMITS.text) },
      ])
    );
    const full = parsed({
      brand: long(DESIGN_TEXT_LIMITS.brand),
      footer: long(DESIGN_TEXT_LIMITS.footer),
      errors,
      lock: {
        title: long(DESIGN_TEXT_LIMITS.title),
        subtitle: long(DESIGN_TEXT_LIMITS.text),
        submit: long(DESIGN_TEXT_LIMITS.submit),
      },
    });
    expect(designSizeError(full)).toBeNull();
  });

  it('nimmt ein Logo genau bis zur genannten Höchstgröße', () => {
    const withPng = parsed({ logo: { kind: 'custom', data: png(8) } });
    const budget = logoByteBudget(withPng);

    const fits = parsed({ logo: { kind: 'custom', data: png(budget) } });
    expect(designSizeError(fits)).toBeNull();
    expect(designPageSizes(fits)[0].bytes).toBeLessThanOrEqual(PAGE_MAX_BYTES);

    const over = parsed({ logo: { kind: 'custom', data: png(budget + 1) } });
    const error = designSizeError(over);
    expect(error).toContain('Das Logo passt nicht in die Seite');
    expect(error).toContain(`höchstens ${budget.toLocaleString('de-DE')} Bytes`);
  });

  it('nennt ohne eigenes Logo eine Grenze, die für jeden Typ hält', () => {
    const budget = logoByteBudget(defaultPageDesign());
    expect(budget).toBeLessThanOrEqual(logoByteBudget(parsed({ logo: { kind: 'custom', data: png(8) } })));
    const svgFits = svg(`<svg xmlns="http://www.w3.org/2000/svg">${'ä'.repeat(Math.floor((budget - 60) / 2))}</svg>`);
    expect(base64ToBytes(svgFits)!.length).toBeLessThanOrEqual(budget);
    expect(designSizeError(parsed({ logo: { kind: 'custom', data: svgFits } }))).toBeNull();
  });

  it('misst die Fehlerdatei samt Kopfzeilen und die Passwortabfrage als Dokument', () => {
    const custom = design({ brand: 'x' });
    const error = DESIGN_PAGES.find((page) => page.id === 'error-503')!;
    const lock = DESIGN_PAGES.find((page) => page.id === 'lock-ask')!;
    expect(designPageFile(error, custom)).toBe(renderErrorFile(503, custom));
    expect(designPageHtml(error, custom)).toBe(renderErrorFile(503, custom).split('\r\n\r\n')[1]);
    expect(designPageFile(lock, custom)).toBe(renderLockPage('ask', custom));
  });

  it('bietet jede Seite an, die HAPM schreibt, und jede genau einmal', () => {
    const ids = DESIGN_PAGES.map((page) => page.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const file of errorFiles()) expect(ids).toContain(`error-${file.status}`);
    expect(ids).toEqual(expect.arrayContaining(['lock-ask', 'lock-wrong', 'lock-throttled']));
    expect(ids.slice(0, 5)).toEqual(['error-404', 'error-403', 'error-502', 'error-503', 'error-504']);
  });
});
