import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { errorFiles, renderErrorFile } from '@/lib/haproxy/error-pages';
import { lockPages, renderLockPage } from '@/lib/haproxy/lock-page';
import { bytesToBase64, defaultPageDesign, PAGE_MAX_BYTES, type PageDesign } from '@/lib/haproxy/page-design';
import { activeBrand, pageBrandFrom, setActiveBrand, type PageBrand } from '@/lib/haproxy/page-brand';
import { brandLogoFit } from '@/lib/haproxy/page-theme';
import { designPageSizes, designSizeError } from '@/lib/haproxy/design-pages';
import { defaultBranding } from '@/lib/branding/branding';
import { contrastRatio } from '@/lib/branding/color';

/**
 * Die Seiten von HAProxy mit der Darstellung: Logo, Name und Akzentfarbe.
 * Ohne Darstellung bleibt jede Seite Byte für Byte, wie sie war
 * (`page-design.test.ts` hält die Prüfsummen fest, hier noch einmal mit
 * ausdrücklich leerer Darstellung).
 */

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const bytes = (text: string) => new TextEncoder().encode(text).length;

const svg = (markup: string) => bytesToBase64(new TextEncoder().encode(markup));

/** Ein PNG aus Signatur und Füllung, `size` Bytes. */
function png(size: number): string {
  const data = new Uint8Array(size);
  data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let i = 8; i < size; i++) data[i] = (i * 31) % 256;
  return bytesToBase64(data);
}

const LOGO = { mime: 'image/svg+xml' as const, data: svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 10"><rect width="40" height="10" fill="#c2410c"/></svg>') };
const LOGO_DARK = { mime: 'image/svg+xml' as const, data: svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 10"><rect width="40" height="10" fill="#fff"/></svg>') };

function brand(over: Partial<PageBrand> = {}): PageBrand {
  return { name: 'Beispiel GmbH', accent: '#c2410c', logo: LOGO, logoDark: null, logoTooLarge: false, ...over };
}

function design(over: Partial<PageDesign>): PageDesign {
  return { ...defaultPageDesign(), ...over };
}

afterEach(() => setActiveBrand(null));

describe('ohne Darstellung', () => {
  it('sind alle Seiten dieselben wie mit leerer Darstellung', () => {
    const withNull = errorFiles(defaultPageDesign(), null).map((file) => sha256(file.content));
    const implicit = errorFiles(defaultPageDesign()).map((file) => sha256(file.content));
    expect(activeBrand()).toBeNull();
    expect(implicit).toEqual(withNull);
    expect(lockPages(defaultPageDesign(), null)).toEqual(lockPages(defaultPageDesign()));
  });

  it('entsteht aus einer Darstellung ohne Name, Farbe und Logo keine', () => {
    expect(pageBrandFrom(defaultBranding(), { logo: null, logoDark: null })).toBeNull();
    const pillOnly = { ...defaultBranding(), pill: { text: 'Kunde', enabled: true } };
    expect(pageBrandFrom(pillOnly, { logo: null, logoDark: null })).toBeNull();
  });
});

describe('„Standard“ mit Darstellung', () => {
  it('zeigt Logo, Name und Akzentfarbe auf der Fehlerseite', () => {
    const file = renderErrorFile(503, defaultPageDesign(), brand());
    expect(file).toContain('data:image/svg+xml');
    expect(file).toContain('alt="Beispiel GmbH"');
    expect(file).toContain('--accent:#c2410c');
    // Das Zeichen von HAPM steht nicht mehr daneben.
    expect(file).not.toContain('fill="#042d20"');
  });

  it('und auf der Passwortabfrage', () => {
    const page = renderLockPage('ask', defaultPageDesign(), brand());
    expect(page).toContain('data:image/svg+xml');
    expect(page).toContain('alt="Beispiel GmbH"');
    expect(page).toContain('--accent:#c2410c');
  });

  it('nimmt die Darstellung, die im Prozess gilt, wenn keine angegeben ist', () => {
    setActiveBrand(brand());
    expect(renderErrorFile(503)).toBe(renderErrorFile(503, defaultPageDesign(), brand()));
  });

  it('setzt ohne Logo den Namen als Text an die Stelle des Zeichens von HAPM', () => {
    const file = renderErrorFile(503, defaultPageDesign(), brand({ logo: null }));
    expect(file).toContain('<span>Beispiel GmbH</span>');
    expect(file).not.toContain('<img');
    expect(file).not.toContain('fill="#042d20"');
  });

  it('lässt mit einer Farbe allein das Logo von HAPM stehen', () => {
    const file = renderErrorFile(503, defaultPageDesign(), brand({ name: null, logo: null }));
    expect(file).toContain('fill="#042d20"');
    expect(file).toContain('--accent:#c2410c');
  });

  it('nimmt die helle Fassung im dunklen Modus, wenn die Seite hell und dunkel kennt', () => {
    const file = renderErrorFile(503, defaultPageDesign(), brand({ accent: null, logoDark: LOGO_DARK }));
    expect(file).toContain('class="ll"');
    expect(file).toContain('class="ld"');
    expect(file).toContain('@media(prefers-color-scheme:dark){.logo .ll{display:none}');
    // Mit Akzentfarbe gibt es nur eine Fassung, und das helle Logo bleibt draußen.
    expect(renderErrorFile(503, defaultPageDesign(), brand({ logoDark: LOGO_DARK }))).not.toContain('class="ld"');
  });
});

describe('„Selbst gestalten“ mit Darstellung', () => {
  it('lässt gesetzte Werte gewinnen', () => {
    const own = design({ mode: 'designed', colors: { accent: '#1d4ed8', background: null, text: null }, brand: 'Eigener Name' });
    const file = renderErrorFile(503, own, brand());
    expect(file).toContain('--accent:#1d4ed8');
    expect(file).not.toContain('--accent:#c2410c');
    expect(file).toContain('<span>Eigener Name</span>');
  });

  it('nimmt aus der Darstellung, was nicht gesetzt ist', () => {
    const file = renderErrorFile(503, design({ mode: 'designed' }), brand());
    expect(file).toBe(renderErrorFile(503, defaultPageDesign(), brand()));
  });

  it('zeigt bei „Keines“ kein Logo, auch nicht das der Darstellung', () => {
    const file = renderErrorFile(503, design({ mode: 'designed', logo: { kind: 'none' } }), brand());
    expect(file).not.toContain('<img');
    expect(file).not.toContain('Beispiel GmbH');
  });
});

describe('eigene HTML-Datei mit Darstellung', () => {
  const custom = design({ mode: 'custom', custom: { html: '<!doctype html><title>Eigen</title><p>Fehler</p>' } });

  it('geht unverändert hinaus', () => {
    expect(renderErrorFile(503, custom, brand())).toBe(renderErrorFile(503, custom, null));
    expect(renderErrorFile(503, custom, brand())).toContain('<p>Fehler</p>');
    expect(renderErrorFile(503, custom, brand())).not.toContain('Beispiel GmbH');
  });

  it('die Passwortabfrage daneben folgt der Darstellung', () => {
    expect(renderLockPage('ask', custom, brand())).toContain('alt="Beispiel GmbH"');
  });
});

describe('ein Logo, das nicht passt', () => {
  const big = { mime: 'image/png' as const, data: png(PAGE_MAX_BYTES - 2000) };

  it('fällt auf den Namen zurück, ohne Fehler', () => {
    const brandBig = brand({ logo: big });
    expect(brandLogoFit(defaultPageDesign(), brandBig)).toBe('name');
    const file = renderErrorFile(503, defaultPageDesign(), brandBig);
    expect(file).not.toContain('data:image/png');
    expect(file).toContain('<span>Beispiel GmbH</span>');
    expect(designSizeError(defaultPageDesign(), 'de', brandBig)).toBeNull();
    for (const size of designPageSizes(defaultPageDesign(), brandBig)) expect(size.bytes).toBeLessThanOrEqual(PAGE_MAX_BYTES);
  });

  it('auch wenn es allein größer ist als eine Seite', () => {
    const tooLarge = pageBrandFrom(
      { ...defaultBranding(), name: 'Beispiel GmbH', images: { logo: { mime: 'image/png', bytes: 40_000, hash: 'x' } } },
      { logo: { mime: 'image/png', data: png(40_000) }, logoDark: null }
    );
    expect(tooLarge?.logo).toBeNull();
    expect(tooLarge?.logoTooLarge).toBe(true);
    const page = renderLockPage('ask', defaultPageDesign(), tooLarge);
    expect(page).toContain('<p class="brand">Beispiel GmbH</p>');
    expect(page).not.toContain('<img');
  });

  it('lässt zuerst die helle Fassung weg, wenn nur das Logo selbst passt', () => {
    const half = { mime: 'image/png' as const, data: png(5_000) };
    const both = brand({ accent: null, logo: half, logoDark: half });
    expect(brandLogoFit(defaultPageDesign(), both)).toBe('light');
    const file = renderErrorFile(503, defaultPageDesign(), both);
    expect(file).toContain('data:image/png');
    expect(file).not.toContain('class="ld"');
    expect(bytes(file)).toBeLessThanOrEqual(PAGE_MAX_BYTES);
  });

  it('ein kleines Logo passt', () => {
    expect(brandLogoFit(defaultPageDesign(), brand())).toBe('light');
    expect(brandLogoFit(defaultPageDesign(), brand({ logoDark: LOGO_DARK }))).toBe('both');
  });
});

describe('die Akzentfarbe aus der Darstellung', () => {
  it('ist die, die auch die Oberfläche zeigt: weiße Schrift mindestens 4,5:1', () => {
    const light = pageBrandFrom({ ...defaultBranding(), accent: '#ffd700' }, { logo: null, logoDark: null });
    expect(light?.accent).not.toBe('#ffd700');
    expect(contrastRatio(light!.accent!, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });
});
