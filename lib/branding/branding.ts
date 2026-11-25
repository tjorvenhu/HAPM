/**
 * Das eigene Aussehen der Oberfläche: Logo, Pille neben dem Logo, Name im
 * Browser-Tab, Akzentfarbe, Symbol im Tab.
 *
 * ── Was hier steht ──
 *
 * Form, Vorgaben und Prüfung, dazu was aus einer Einstellung im Kopf jeder
 * Seite landet (`brandingStyle`, `faviconHref`) und das erzeugte Symbol
 * (`faviconSvg`). Wo es liegt, steht in `store.ts`, die Farben in `color.ts`.
 * Rein und ohne Umgebung: das Formular prüft im Browser mit denselben Regeln.
 *
 * ── Vorgabe heißt: nichts gesetzt ──
 *
 * Ohne Farbe, Logo, Name und Pille schreibt das Layout nichts in den Kopf der
 * Seite und lässt die Favicons aus `public/` stehen. Die Oberfläche sieht dann
 * aus wie vor dieser Einstellung, Byte für Byte.
 *
 * ── Was nicht dazugehört ──
 *
 * Mails (`ui/mail/`, `lib/mail/`) und die Fehlerseiten von HAProxy
 * (`lib/haproxy/page-design.ts`) haben ihr eigenes Aussehen: eine Mail geht
 * auch an Empfänger, für die die Oberfläche keine Rolle spielt, und eine
 * Fehlerseite sieht der Besucher eines Ziels, nicht der Betreiber.
 */

import { sniffLogoType, base64ToBytes, type LogoMime } from '@/lib/haproxy/page-design';
import { STATIC_LOGO_SVG } from '@/ui/static/logo';
import { createTranslator, formatNumber, DEFAULT_LOCALE, type Locale } from '@/lib/i18n';
import { accentVariables, deriveAccent, isHexColor, HAPM_ACCENT } from './color';

export const BRANDING_IMAGE_SLOTS = ['logo', 'logoDark', 'icon'] as const;
export type BrandingImageSlot = (typeof BRANDING_IMAGE_SLOTS)[number];

/** Was ein Bild hier sein darf. JPEG nicht: ein Logo braucht einen durchsichtigen Grund. */
export const BRANDING_IMAGE_TYPES: Partial<Record<LogoMime, string>> = {
  'image/svg+xml': 'SVG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
};

/** Größte Datei je Bild, in Bytes. Ein Logo als SVG hat selten mehr als 20 KB. */
export const BRANDING_IMAGE_MAX_BYTES = 256 * 1024;

export const BRANDING_LIMITS = {
  name: 40,
  pill: 16,
} as const;

export interface BrandingImageMeta {
  mime: LogoMime;
  bytes: number;
  /** Kurzer Fingerabdruck des Inhalts. Hängt an der Adresse, damit der Browser ein neues Bild holt. */
  hash: string;
}

export interface Branding {
  /** Name im Browser-Tab statt „HAPM". `null`: HAPM. */
  name: string | null;
  /** Der Text bleibt beim Ausschalten stehen. */
  pill: { text: string; enabled: boolean };
  /** `#rrggbb` oder `null` für das Grün von HAPM. */
  accent: string | null;
  images: Partial<Record<BrandingImageSlot, BrandingImageMeta>>;
}

export interface BrandingImage {
  mime: LogoMime;
  /** Die Datei als Base64. */
  data: string;
}

export function defaultBranding(): Branding {
  return { name: null, pill: { text: '', enabled: false }, accent: null, images: {} };
}

/** Der Name, der im Tab steht. */
export const DEFAULT_TOOL_NAME = 'HAPM';

export function toolName(branding: Pick<Branding, 'name'>): string {
  return branding.name ?? DEFAULT_TOOL_NAME;
}

/** Ob irgendetwas von der Vorgabe abweicht. */
export function hasBranding(branding: Branding): boolean {
  return (
    branding.name !== null ||
    branding.accent !== null ||
    (branding.pill.enabled && branding.pill.text !== '') ||
    Object.keys(branding.images).length > 0
  );
}

/* ── Prüfen ── */

type Result<T> = { value: T } | { error: string };
type T = ReturnType<typeof createTranslator>['t'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Eine Zeile: Steuerzeichen und Umbrüche werden zu einem Leerzeichen. */
function cleanLine(value: string): string {
  return value.replace(/[\p{Cc}\s]+/gu, ' ').trim();
}

/** Buchstaben, Ziffern und wenige Zeichen, die in einem Kürzel vorkommen. */
const PILL_PATTERN = /^[\p{L}\p{N}](?:[\p{L}\p{N} .&+/_-]*[\p{L}\p{N}.+])?$/u;

/**
 * Die Pille: kurz und ohne Zeichen, die in einer Kennzeichnung nichts zu
 * suchen haben. Eine leere Pille geht nur ausgeschaltet.
 */
export function parsePill(value: unknown, t: T): Result<Branding['pill']> {
  if (!isRecord(value)) return { error: t('Die Pille ist ungültig.') };
  if (typeof value.enabled !== 'boolean') return { error: t('Die Pille ist entweder an oder aus.') };
  if (typeof value.text !== 'string') return { error: t('Der Text der Pille ist kein Text.') };
  const text = cleanLine(value.text);
  if (text.length > BRANDING_LIMITS.pill) {
    return { error: t('Die Pille hat höchstens {max} Zeichen.', { max: BRANDING_LIMITS.pill }) };
  }
  if (text && !PILL_PATTERN.test(text)) {
    return {
      error: t('Die Pille besteht aus Buchstaben, Ziffern und Leerzeichen, dazu . - + & / _ zwischen ihnen.'),
    };
  }
  if (value.enabled && !text) return { error: t('Die Pille ist eingeschaltet, aber ohne Text.') };
  return { value: { text, enabled: value.enabled } };
}

export function parseName(value: unknown, t: T): Result<string | null> {
  if (value === null || value === undefined) return { value: null };
  if (typeof value !== 'string') return { error: t('Der Name ist kein Text.') };
  const text = cleanLine(value);
  if (!text) return { value: null };
  if (text.length > BRANDING_LIMITS.name) {
    return { error: t('Der Name hat höchstens {max} Zeichen.', { max: BRANDING_LIMITS.name }) };
  }
  return { value: text };
}

export function parseAccent(value: unknown, t: T): Result<string | null> {
  if (value === null || value === undefined || value === '') return { value: null };
  if (!isHexColor(value)) return { error: t('Die Akzentfarbe ist keine Farbe in der Form #rrggbb.') };
  return { value: value.toLowerCase() };
}

/**
 * Was ein SVG an dieser Stelle nicht enthalten darf. Die Oberfläche zeigt es
 * als `<img>`, dort liefe nichts davon. Unter seiner eigenen Adresse öffnet es
 * der Browser aber als Dokument der Oberfläche, und dort liefe ein Skript.
 * Die Route schickt zusätzlich `Content-Security-Policy: sandbox`.
 */
const SVG_ACTIVE_CONTENT = /<script|<foreignObject|<iframe|<embed|<object|\son[a-z]+\s*=|javascript:|<!ENTITY/i;

/** Größe und Inhalt eines Bildes. Die Art kommt aus den ersten Bytes, nicht aus der Endung. */
export function readBrandingImage(data: unknown, locale: Locale = DEFAULT_LOCALE): Result<BrandingImage> {
  const { t } = createTranslator(locale);
  if (typeof data !== 'string') return { error: t('Das Bild ist ungültig.') };
  if (data.length > Math.ceil(BRANDING_IMAGE_MAX_BYTES / 3) * 4) return { error: imageTooLargeMessage(locale) };
  const bytes = base64ToBytes(data);
  if (!bytes) return { error: t('Das Bild ließ sich nicht lesen.') };
  return checkImageBytes(bytes, locale, data);
}

/** Dieselbe Prüfung für eine Datei im Browser, bevor sie gelesen wird. */
export function checkImageBytes(bytes: Uint8Array, locale: Locale = DEFAULT_LOCALE, base64?: string): Result<BrandingImage> {
  const { t } = createTranslator(locale);
  if (bytes.length > BRANDING_IMAGE_MAX_BYTES) return { error: imageTooLargeMessage(locale) };
  const mime = sniffLogoType(bytes);
  if (!mime || !(mime in BRANDING_IMAGE_TYPES)) {
    return { error: t('Das Bild ist kein SVG, PNG oder WebP. Geprüft wird der Inhalt der Datei, nicht ihre Endung.') };
  }
  if (mime === 'image/svg+xml' && SVG_ACTIVE_CONTENT.test(new TextDecoder().decode(bytes))) {
    return { error: t('Das SVG enthält Skripte, Ereignisse oder eingebettete Dokumente. Ein Logo braucht davon nichts.') };
  }
  return { value: { mime, data: base64 ?? bytesToBase64(bytes) } };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function imageTooLargeMessage(locale: Locale = DEFAULT_LOCALE): string {
  return createTranslator(locale).t('Das Bild ist zu groß. Erlaubt sind bis {max} KB.', {
    max: formatNumber(locale, BRANDING_IMAGE_MAX_BYTES / 1024),
  });
}

/** FNV-1a über den Inhalt. Kein Schutz, nur ein Name für den Cache. */
export function imageHash(data: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    hash ^= data.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function imageMeta(image: BrandingImage): BrandingImageMeta {
  const padding = image.data.match(/=+$/)?.[0].length ?? 0;
  return { mime: image.mime, bytes: (image.data.length * 3) / 4 - padding, hash: imageHash(image.data) };
}

/**
 * Eine gelesene Zeile mit den Vorgaben für alles, was fehlt oder nicht passt.
 * Eine Zeile, die eine enger gewordene Regel nicht mehr besteht, fällt für
 * dieses Feld auf die Vorgabe zurück, statt die Oberfläche anzuhalten.
 */
export function normalizeBranding(row: unknown): Branding {
  const raw = isRecord(row) ? row : {};
  const { t } = createTranslator(DEFAULT_LOCALE);
  const name = parseName(raw.name, t);
  const pill = parsePill(raw.pill, t);
  const accent = parseAccent(raw.accent, t);
  const images: Branding['images'] = {};
  if (isRecord(raw.images)) {
    for (const slot of BRANDING_IMAGE_SLOTS) {
      const meta = raw.images[slot];
      if (
        isRecord(meta) &&
        typeof meta.mime === 'string' &&
        meta.mime in BRANDING_IMAGE_TYPES &&
        typeof meta.hash === 'string' &&
        typeof meta.bytes === 'number'
      ) {
        images[slot] = { mime: meta.mime as LogoMime, hash: meta.hash, bytes: meta.bytes };
      }
    }
  }
  return {
    name: 'value' in name ? name.value : null,
    pill: 'value' in pill ? pill.value : defaultBranding().pill,
    accent: 'value' in accent ? accent.value : null,
    images,
  };
}

/* ── Was die Seiten davon sehen ── */

/** Adresse eines Bildes, mit dem Fingerabdruck als Name für den Cache. */
export function imageUrl(slot: BrandingImageSlot, meta: BrandingImageMeta | undefined): string | null {
  if (!meta) return null;
  if (slot === 'icon') return `/api/branding/favicon?v=${meta.hash}`;
  return `/api/branding/logo/${slot === 'logo' ? 'light' : 'dark'}?v=${meta.hash}`;
}

/** Was die Seite „Darstellung" sieht. */
export interface BrandingView {
  name: string | null;
  pill: Branding['pill'];
  accent: string | null;
  images: Record<BrandingImageSlot, { url: string; mime: string; bytes: number } | null>;
}

/** Was jede Seite braucht, auch vor der Anmeldung. Nichts davon ist geheim: die Anmeldeseite zeigt es. */
export interface PublicBranding {
  name: string | null;
  /** Der Text der Pille, wenn sie an ist. */
  pill: string | null;
  logo: string | null;
  logoDark: string | null;
}

export function publicBranding(branding: Branding): PublicBranding {
  return {
    name: branding.name,
    pill: branding.pill.enabled && branding.pill.text ? branding.pill.text : null,
    logo: imageUrl('logo', branding.images.logo),
    logoDark: imageUrl('logoDark', branding.images.logoDark),
  };
}

/**
 * Die Farben als Regel für den Kopf der Seite, oder `null` ohne eigene Farbe.
 *
 * `:root:root` schlägt `:root` aus `tool-vocabulary.css` und
 * `html:has(.app-shell)` aus `08-shell-tokens.css`, egal in welcher Reihenfolge
 * die Stylesheets im Kopf stehen. Die Werte sind Hex, Zahlen und `rgba()`, alle
 * hier berechnet: aus der Eingabe kommt nichts unverändert in die Regel.
 */
export function brandingStyle(branding: Pick<Branding, 'accent'>): string | null {
  if (!branding.accent || !isHexColor(branding.accent)) return null;
  const declarations = Object.entries(accentVariables(branding.accent.toLowerCase()))
    .map(([name, value]) => `${name}:${value}`)
    .join(';');
  return `:root:root{${declarations}}`;
}

/**
 * Das Symbol im Tab. `null`: die Favicons aus `public/`.
 *
 * Ein hochgeladenes Symbol gilt immer. Sonst entsteht eines, sobald es etwas
 * gibt, das das Grün von HAPM ersetzen soll: mit Namen der Anfangsbuchstabe auf
 * der Akzentfarbe, mit Farbe allein das Zeichen von HAPM in dieser Farbe. Aus
 * einem breiten Logo lässt sich kein Quadrat schneiden, deshalb wird es nicht
 * verkleinert.
 */
export function faviconHref(branding: Branding): string | null {
  const icon = imageUrl('icon', branding.images.icon);
  if (icon) return icon;
  if (!branding.name && !branding.accent) return null;
  return `/api/branding/favicon?v=${imageHash(`${branding.name ?? ''}|${branding.accent ?? ''}`)}`;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Die beiden Teile des Zeichens von HAPM aus `ui/static/logo.ts`, ohne den Schriftzug. */
const MARK_PATHS = [...STATIC_LOGO_SVG.matchAll(/<path fill="(#[0-9a-f]{6})"([^>]*)\/>/g)].slice(0, 2);

/** Das erzeugte Symbol als SVG. Nur aufrufen, wenn `faviconHref` kein hochgeladenes nennt. */
export function faviconSvg(branding: Pick<Branding, 'name' | 'accent'>): string {
  const palette = deriveAccent(branding.accent ?? HAPM_ACCENT);
  const letter = branding.name ? [...branding.name.trim()][0]?.toLocaleUpperCase() : undefined;
  if (letter) {
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
      `<rect width="64" height="64" rx="14" fill="${palette.accent}"/>` +
      '<text x="32" y="44" text-anchor="middle" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" ' +
      `font-size="34" font-weight="700" fill="#ffffff">${escapeXml(letter)}</text></svg>`
    );
  }
  // Zwei Töne wie im Original: der linke Teil im Akzent, der rechte in seinem Hover.
  const [dark, light] = MARK_PATHS;
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="198 184 567 351">' +
    `<path fill="${palette.accent}"${dark?.[2] ?? ''}/>` +
    `<path fill="${palette.hover}"${light?.[2] ?? ''}/></svg>`
  );
}

/* ── Eingabe der Route ── */

export interface BrandingInput {
  name: string | null;
  pill: Branding['pill'];
  accent: string | null;
  /** Je Bild: neu, entfernt (`null`) oder unverändert (fehlt). */
  images: Partial<Record<BrandingImageSlot, BrandingImage | null>>;
}

/**
 * Die ganze Eingabe der Karte, oder der erste Grund, warum nicht. Die Gründe
 * stehen schon in `locale`: sie setzen Zahlen in einen Satz.
 */
export function parseBrandingInput(raw: unknown, locale: Locale = DEFAULT_LOCALE): Result<BrandingInput> {
  const { t } = createTranslator(locale);
  if (!isRecord(raw)) return { error: t('Die Eingabe ist ungültig.') };

  const name = parseName(raw.name, t);
  if ('error' in name) return name;
  const pill = parsePill(raw.pill, t);
  if ('error' in pill) return pill;
  const accent = parseAccent(raw.accent, t);
  if ('error' in accent) return accent;

  const images: BrandingInput['images'] = {};
  if (raw.images !== undefined && raw.images !== null) {
    if (!isRecord(raw.images)) return { error: t('Die Bilder sind ungültig.') };
    for (const slot of BRANDING_IMAGE_SLOTS) {
      const value = raw.images[slot];
      if (value === undefined) continue;
      if (value === null) {
        images[slot] = null;
        continue;
      }
      if (!isRecord(value)) return { error: t('Das Bild ist ungültig.') };
      const image = readBrandingImage(value.data, locale);
      if ('error' in image) return image;
      images[slot] = image.value;
    }
  }
  return { value: { name: name.value, pill: pill.value, accent: accent.value, images } };
}
