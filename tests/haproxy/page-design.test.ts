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
 *  - Die Vorgabe muss Byte für Byte festgehaltene Seiten ergeben. Eine
 *    unbemerkte Änderung ließe jede bestehende Installation nach dem Update als
 *    „Andere Seite“ gelten, und der nächste Klick ersetzte womöglich eine Seite
 *    von Hand.
 *  - Was ein Benutzer eintippt, landet in einer Seite, die HAProxy jedem
 *    Besucher zeigt: maskiert, Farben nur in der einen Form, ein Logo nur als
 *    eingebettetes Bild.
 *  - Eine zu große Seite nimmt HAProxy an und beantwortet sie mit 500
 *    (Passwortabfrage) oder lehnt die ganze Konfiguration ab (Fehlerdatei).
 */

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Die Prüfsummen der Seiten von HAPM ohne eigenes Design („Standard“). Ändert
 * sich die Vorlage absichtlich, ändern sich diese Zahlen mit, und jede
 * Installation sieht ihre Dateien danach als „Andere Seite“. Das ist dann eine
 * Entscheidung, kein Versehen: zuletzt die Fehlerseite in der Schrift des
 * Systems mit heller und dunkler Fassung. Die Passwortabfrage blieb dabei
 * gleich, ihre Zahlen sind noch die von vor dem Design.
 */
const STANDARD: Record<string, string> = {
  'error-400': '6b671ff1f4846d68d83dc238d4908f203232757130d5c303f8bd562fd6409569',
  'error-401': 'bcaba2cae133aca070a5d97e97e0b7921a39ee0f8ae98a21c24e9d3824577290',
  'error-403': 'f5f228ec9cf17b33254d3d905aefdd86cdf310c01715ff1b007657463eee7ac1',
  'error-404': 'bbc9333629b5dbd0e2fc171208608ccb97b1227e00256e1db003b3acc324fa4f',
  'error-405': '5afac10d53179226859e9d4e8fd0fff25c90046a8944387b8faee72219fdc3d8',
  'error-408': 'd70ca461075e4997beaa5f993dc24403f0eccaa7cd99de3097ac3e1b079d3d11',
  'error-410': '258bba2a58dbeb200eb0d2950db8da77fb75739dc919fe2f378ab3f2c2991954',
  'error-413': '2c04183e09ceb35ebd4911f8a3b2d045941f9bf1341ba87b791d76af72ae7d98',
  'error-429': '76669b3a0a42597abea969b18d56a34d06d04fcee3d46e6dd61c31398130d5ba',
  'error-500': 'e6453d496a5a56f5eb458ed31ad8b8c1c9f5aba9f71cdf4a8d606c81c336bedb',
  'error-501': '25bf84c6bdfb399dc7aa23132833b18e487296d235cd9cc4fbc138a80980c1b1',
  'error-502': 'ec38ffdc252b4a0a8f7ff6627656612d545a08b123400bc58bf3df9ed243307f',
  'error-503': '0acf73df7e2784feb9fd7cca6e99b46d02035ce6facde77af93051898401b03c',
  'error-504': '474944f8940bb1b63b9b4b7f9b3b04c4d787e94e4ec37a219dbc7fb4d9ff3dbb',
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
  it('ergibt Byte für Byte die festgehaltenen Seiten', () => {
    expect(digests(defaultPageDesign())).toEqual(STANDARD);
  });

  it('auch ohne Angabe, also mit dem Design, das im Prozess gilt', () => {
    expect(digests()).toEqual(STANDARD);
  });

  it('auch nach dem Weg durch die Prüfung und die Datenbank', () => {
    // Was gespeichert und wieder gelesen wurde, trägt Metadaten der Zeile mit.
    const stored = { ...JSON.parse(JSON.stringify(defaultPageDesign())), $id: 'main', $createdAt: 'x' };
    const read = parsed(stored);
    expect(isDefaultDesign(read)).toBe(true);
    expect(digests(read)).toEqual(STANDARD);
  });

  it('auch wenn ein Text genau der Vorgabe entspricht', () => {
    const same = parsed({ errors: { 503: { title: 'Gerade nicht erreichbar' } } });
    expect(sha256(renderErrorFile(503, same))).toBe(STANDARD['error-503']);
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
  'error-400': 'd6d303fa57b3e2c4fa178dd8fd9fda08b76e28c117bad70e08a83f89f352f0b5',
  'error-401': '3e04ceca51e95d1a8c0ac39fb2f9569a50b632799c62d59adfcf77829f2e3b39',
  'error-403': '529a926938172dcd0f6435a8d72f9e3a85ba1f6887af1158b6195336b8f301df',
  'error-404': '8c646b91b8ddd176d4178eeda59b0421e602ef2c3455ba3ecb416fe83a2d0b2e',
  'error-405': '22de822bcd4e3e5cf413be688fef4f6e890bb7f14741cbd801ba2bba7c896d97',
  'error-408': '5d70d48661816091858b7136e9bd9e03a26c8fa23b28de523486217c9feacf3b',
  'error-410': '6077edcf82bfe7f2de02e0e58485e8ab0ceb2b8623587aa836648a17177755e4',
  'error-413': 'd1bdbcde484b6d8f62dc6a7c5c798be972aa8590c65e5a3c616008dd2133e194',
  'error-429': 'db6ccfe267ef97c1d0844d95e39127ad10d28ff9392a1a0b5a924b5b785809b8',
  'error-500': '03feb35ad923a85bbae84e8c8d57730f1b43b1d631c95c923cf856913c25bf86',
  'error-501': 'd2a75d83345690cfa33687392e9ae3f0570752fbede5115b23807fd09428baff',
  'error-502': 'eb544cef6d6c2615c34e182ce89164222e1232454a10d7fca209eb1288a51175',
  'error-503': '301d852f80a710230ab6278c27085f7d70ce8ab172bdcce4fd0a87177ab33465',
  'error-504': '1e1e94ef0fe5fac5b1940acab690f02472ef812633a01b5480f55fd993d41f3d',
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
    expect(digests(parsed({ ...before, locale: 'de' }))).toEqual(STANDARD);
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
    expect(renderErrorFile(503, parsed({ colors: { accent: '#ffee00' } }))).toContain('--on-accent:#0f0f0f');
    expect(renderErrorFile(503, parsed({ colors: { accent: '#202060' } }))).toContain('--on-accent:#fff');
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
