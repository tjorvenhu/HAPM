import { describe, it, expect } from 'vitest';
import {
  BRANDING_IMAGE_MAX_BYTES,
  brandingStyle,
  checkImageBytes,
  defaultBranding,
  faviconHref,
  faviconSvg,
  hasBranding,
  normalizeBranding,
  parseBrandingInput,
  parsePill,
  publicBranding,
  readBrandingImage,
  toolName,
  type Branding,
} from '@/lib/branding/branding';
import { createTranslator } from '@/lib/i18n';

const { t } = createTranslator('de');
const pill = (text: string, enabled = true) => parsePill({ text, enabled }, t);

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const svg = (body: string) => new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`);

describe('parsePill', () => {
  it('nimmt kurze Kennzeichnungen', () => {
    for (const text of ['RevProxy', 'Proxy', 'Kunde A', 'R&D', 'v2.1', 'Prod/EU', 'Größe', 'DMZ-01', 'C++']) {
      expect(pill(text)).toEqual({ value: { text, enabled: true } });
    }
  });

  it('räumt Leerraum auf', () => {
    expect(pill('  Kunde \n A ')).toEqual({ value: { text: 'Kunde A', enabled: true } });
  });

  it('lehnt zu lange und fremde Zeichen ab', () => {
    expect(pill('x'.repeat(17))).toHaveProperty('error');
    expect(pill('x'.repeat(16))).toHaveProperty('value');
    for (const text of ['<b>', 'Proxy!', '"quote"', '-Proxy', 'Proxy-', 'a;b', 'Emoji 🚀']) {
      expect(pill(text), text).toHaveProperty('error');
    }
  });

  it('erlaubt leer nur ausgeschaltet', () => {
    expect(pill('', true)).toHaveProperty('error');
    expect(pill('', false)).toEqual({ value: { text: '', enabled: false } });
    expect(parsePill({ text: 'x', enabled: 'ja' }, t)).toHaveProperty('error');
    expect(parsePill(null, t)).toHaveProperty('error');
  });
});

describe('Bilder', () => {
  it('nimmt PNG und SVG, geprüft am Inhalt', () => {
    expect(checkImageBytes(PNG)).toMatchObject({ value: { mime: 'image/png' } });
    expect(checkImageBytes(svg('<path d="M0 0h1"/>'))).toMatchObject({ value: { mime: 'image/svg+xml' } });
  });

  it('lehnt JPEG und Unbekanntes ab', () => {
    expect(checkImageBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toHaveProperty('error');
    expect(checkImageBytes(new TextEncoder().encode('<html></html>'))).toHaveProperty('error');
  });

  it('lehnt SVG mit Skript, Ereignis oder fremdem Dokument ab', () => {
    for (const body of [
      '<script>alert(1)</script>',
      '<rect onload="x()"/>',
      '<a href="javascript:x()"/>',
      '<foreignObject><div/></foreignObject>',
    ]) {
      expect(checkImageBytes(svg(body)), body).toHaveProperty('error');
    }
  });

  it('prüft die Größe vor dem Entpacken', () => {
    const big = 'A'.repeat(Math.ceil(BRANDING_IMAGE_MAX_BYTES / 3) * 4 + 4);
    expect(readBrandingImage(big)).toHaveProperty('error');
    expect(readBrandingImage('kein base64!')).toHaveProperty('error');
    expect(readBrandingImage(base64(PNG))).toMatchObject({ value: { mime: 'image/png', data: base64(PNG) } });
  });
});

describe('parseBrandingInput', () => {
  it('nimmt die ganze Karte', () => {
    const parsed = parseBrandingInput({
      name: '  Acme Proxy ',
      pill: { text: 'Prod', enabled: true },
      accent: '#1D4ED8',
      images: { logo: { data: base64(PNG) }, icon: null },
    });
    expect(parsed).toMatchObject({
      value: { name: 'Acme Proxy', pill: { text: 'Prod', enabled: true }, accent: '#1d4ed8', images: { icon: null } },
    });
    expect('value' in parsed && parsed.value.images.logo?.mime).toBe('image/png');
    expect('value' in parsed && 'logoDark' in parsed.value.images).toBe(false);
  });

  it('leerer Name heißt HAPM', () => {
    expect(parseBrandingInput({ name: '  ', pill: { text: '', enabled: false }, accent: null })).toMatchObject({
      value: { name: null },
    });
  });

  it('meldet den ersten Fehler in der Sprache der Anfrage', () => {
    expect(parseBrandingInput({ name: null, pill: { text: '', enabled: false }, accent: 'grün' }, 'en')).toEqual({
      error: 'The accent color is not a color in the form #rrggbb.',
    });
    expect(parseBrandingInput({ name: 'x'.repeat(41), pill: { text: '', enabled: false }, accent: null })).toHaveProperty('error');
  });
});

describe('normalizeBranding', () => {
  it('füllt eine leere oder fremde Zeile mit den Vorgaben', () => {
    expect(normalizeBranding(null)).toEqual(defaultBranding());
    expect(normalizeBranding({ accent: 'rot', pill: 'x', images: { logo: { mime: 'image/jpeg', hash: 'a', bytes: 1 } } })).toEqual(
      defaultBranding()
    );
  });

  it('behält gültige Felder', () => {
    const row = {
      $id: 'main',
      name: 'Acme',
      pill: { text: 'Prod', enabled: false },
      accent: '#7c3aed',
      images: { logo: { mime: 'image/svg+xml', hash: 'abc', bytes: 1200 } },
    };
    expect(normalizeBranding(row)).toEqual({
      name: 'Acme',
      pill: { text: 'Prod', enabled: false },
      accent: '#7c3aed',
      images: { logo: { mime: 'image/svg+xml', hash: 'abc', bytes: 1200 } },
    });
  });
});

describe('Was die Seiten sehen', () => {
  const custom: Branding = {
    name: 'Acme',
    pill: { text: 'Prod', enabled: true },
    accent: '#7c3aed',
    images: { logo: { mime: 'image/svg+xml', hash: 'abc', bytes: 1200 } },
  };

  it('ohne Einstellung bleibt alles wie bei HAPM', () => {
    const plain = defaultBranding();
    expect(hasBranding(plain)).toBe(false);
    expect(brandingStyle(plain)).toBeNull();
    expect(faviconHref(plain)).toBeNull();
    expect(toolName(plain)).toBe('HAPM');
    expect(publicBranding(plain)).toEqual({ name: null, pill: null, logo: null, logoDark: null });
  });

  it('eine ausgeschaltete Pille zeigt nichts, behält aber den Text', () => {
    const off = { ...custom, pill: { text: 'Prod', enabled: false } };
    expect(publicBranding(off).pill).toBeNull();
  });

  it('nennt Logo und Name mit Fingerabdruck in der Adresse', () => {
    expect(publicBranding(custom)).toEqual({ name: 'Acme', pill: 'Prod', logo: '/api/branding/logo/light?v=abc', logoDark: null });
    expect(toolName(custom)).toBe('Acme');
  });

  it('schreibt die Farben als Regel, die die Stylesheets schlägt', () => {
    const style = brandingStyle(custom);
    expect(style).toMatch(/^:root:root\{--accent:#7c3aed;/);
    expect(brandingStyle({ accent: '#7c3aed;}body{display:none' })).toBeNull();
  });

  it('erzeugt das Symbol: Buchstabe mit Namen, sonst das Zeichen von HAPM', () => {
    expect(faviconHref(custom)).toMatch(/^\/api\/branding\/favicon\?v=/);
    const letter = faviconSvg({ name: 'acme', accent: '#7c3aed' });
    expect(letter).toContain('>A</text>');
    expect(letter).toContain('fill="#7c3aed"');
    expect(faviconSvg({ name: '<b>', accent: null })).toContain('&#60;');
    const mark = faviconSvg({ name: null, accent: '#1d4ed8' });
    expect(mark.match(/<path /g)).toHaveLength(2);
    expect(mark).toContain('fill="#1d4ed8"');
  });

  it('ein hochgeladenes Symbol gilt vor dem erzeugten', () => {
    const withIcon = { ...custom, images: { ...custom.images, icon: { mime: 'image/png' as const, hash: 'ic', bytes: 10 } } };
    expect(faviconHref(withIcon)).toBe('/api/branding/favicon?v=ic');
  });
});
