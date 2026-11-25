/**
 * Was die Seiten von HAProxy (Fehlerseiten, Passwortabfrage) aus der
 * Darstellung übernehmen: Logo, Name und Akzentfarbe.
 *
 * ── Wer gewinnt ──
 *
 * „Standard“ nimmt alles aus der Darstellung. „Selbst gestalten“ nimmt nur,
 * was dort nicht gesetzt ist: eine eigene Akzentfarbe, ein eigenes Logo oder
 * „Kein Logo“ und ein eigener Schriftzug gewinnen. Die eigene HTML-Datei
 * bekommt nichts, die Passwortabfrage daneben bleibt die Seite von HAPM und
 * folgt damit der Darstellung wie bei „Standard“.
 *
 * Ohne Darstellung (`null`) entsteht Byte für Byte die Seite von vorher.
 *
 * ── Das Logo und die Größe ──
 *
 * Ein Logo der Darstellung darf bis 256 KB groß sein, eine ganze Seite nur
 * 15.000 Bytes (`PAGE_MAX_BYTES`). Welche Fassung hineinpasst, entscheidet
 * `brandLogoFit` in `page-theme.ts` an den fertigen Seiten: helles und dunkles
 * Logo, nur das helle, oder statt des Logos der Name als Text. Verkleinert wird
 * nichts. Eine Datei, die schon allein größer ist als eine Seite, kommt gar
 * nicht erst mit (`logoTooLarge`): sie ginge bis zu 350 KB an den Browser,
 * nur um dort durchzufallen.
 *
 * Rein und ohne Umgebung: das Formular rechnet damit im Browser dieselbe
 * Vorschau aus wie die Route auf dem Server.
 */

import type { StaticTheme } from '@/ui/static/page';
import type { Branding, BrandingImage } from '@/lib/branding/branding';
import { readableAccent } from '@/lib/branding/color';
import { designTheme, logoDataUri, PAGE_MAX_BYTES, type LogoMime, type PageDesign } from './page-design';

export interface PageBrandImage {
  mime: LogoMime;
  /** Die Datei als Base64. */
  data: string;
}

export interface PageBrand {
  /** Name aus der Darstellung, `null` ohne. */
  name: string | null;
  /** Die Akzentfarbe, wie die Oberfläche sie zeigt (weiße Schrift mindestens 4,5:1). */
  accent: string | null;
  /** Das Logo für helle Flächen. */
  logo: PageBrandImage | null;
  /** Die helle Fassung für dunkle Flächen. */
  logoDark: PageBrandImage | null;
  /** Es gibt ein Logo, aber es ist allein schon größer als eine Seite. */
  logoTooLarge: boolean;
}

/** Mehr Base64 trägt keine Seite. */
const IMAGE_BASE64_MAX = Math.ceil(PAGE_MAX_BYTES / 3) * 4;

function pageImage(image: BrandingImage | null): PageBrandImage | 'too-large' | null {
  if (!image) return null;
  return image.data.length > IMAGE_BASE64_MAX ? 'too-large' : { mime: image.mime, data: image.data };
}

/**
 * Aus der Darstellung, was die Seiten brauchen. `null`, wenn nichts davon
 * gesetzt ist (eine Pille allein oder nur ein Symbol für den Tab zählen nicht).
 */
export function pageBrandFrom(
  branding: Branding,
  images: { logo: BrandingImage | null; logoDark: BrandingImage | null }
): PageBrand | null {
  const logo = branding.images.logo ? pageImage(images.logo) : null;
  const logoDark = branding.images.logoDark ? pageImage(images.logoDark) : null;
  const brand: PageBrand = {
    name: branding.name,
    accent: branding.accent ? readableAccent(branding.accent) : null,
    logo: logo === 'too-large' ? null : logo,
    // Ohne helles Logo gibt es keine Umschaltung, und eine dunkle Fassung allein ersetzt es nicht.
    logoDark: logo && logo !== 'too-large' && logoDark && logoDark !== 'too-large' ? logoDark : null,
    logoTooLarge: logo === 'too-large',
  };
  return brand.name || brand.accent || brand.logo || brand.logoTooLarge ? brand : null;
}

/* ── Was gerade gilt ──
 *
 * Wie `activeDesign` in `page-design.ts`: gesetzt beim Start, bei jedem Lesen
 * des Designs und nach dem Speichern der Darstellung, am globalen Objekt, weil
 * Next die Routen einzeln baut. */

const holder = globalThis as typeof globalThis & { __hapmPageBrand?: PageBrand | null };

export function activeBrand(): PageBrand | null {
  return holder.__hapmPageBrand ?? null;
}

export function setActiveBrand(brand: PageBrand | null): void {
  holder.__hapmPageBrand = brand;
}

/* ── Das Aussehen einer Seite ── */

/**
 * Wie viel vom Logo der Darstellung in die Seiten passt: `both` helles und
 * dunkles, `light` nur das helle, `name` keines, dafür der Name als Text.
 */
export type BrandLogoFit = 'both' | 'light' | 'name';

/** Ob die Seiten das Logo der Darstellung zeigen würden, wenn es passt. */
export function usesBrandLogo(design: PageDesign, brand: PageBrand | null): boolean {
  return !!brand && design.logo.kind === 'hapm' && (brand.logo !== null || brand.logoTooLarge);
}

/**
 * Was `ui/static/page.ts` bekommt. `design` ist das Design, nach dem die Seite
 * im Aufbau von HAPM entsteht (`builtInDesign`), `fit` kommt aus
 * `brandLogoFit`.
 */
export function brandedTheme(design: PageDesign, brand: PageBrand | null, fit: BrandLogoFit = 'both'): StaticTheme {
  const theme = designTheme(design);
  if (!brand) return theme;

  if (!theme.accent && brand.accent) theme.accent = brand.accent;

  if (design.logo.kind === 'hapm') {
    if (brand.logo && fit !== 'name') {
      theme.logo = {
        src: logoDataUri(brand.logo),
        ...(fit === 'both' && brand.logoDark ? { darkSrc: logoDataUri(brand.logoDark) } : {}),
      };
    } else if (brand.logo || brand.logoTooLarge || brand.name) {
      // Ein Logo, das nicht passt, oder ein Name ohne Logo: das Zeichen von HAPM
      // gehört nicht auf die Seite eines anderen Namens.
      theme.logo = null;
      if (!theme.brand && brand.name) theme.brand = brand.name;
    }
  }

  // Ein Bild ohne Schriftzug daneben nennt den Namen als Alternativtext.
  if (theme.logo && !theme.brand && brand.name) theme.logo = { ...theme.logo, alt: brand.name };
  return theme;
}
