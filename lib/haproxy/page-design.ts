/**
 * Das Design der Seiten, die HAProxy selbst ausliefert: Fehlerseiten und
 * Passwortabfrage. Farben, Logo, Schriftzug, Fußzeile und Texte.
 *
 * ── Was hier steht und was nicht ──
 *
 * Die Form des Designs, seine Prüfung und der Weg vom Design zu dem, was der
 * Baustein `ui/static/page.ts` annimmt (`designTheme`). Wie eine Seite aussieht,
 * steht dort. Wo das Design liegt, steht in `page-design-store.ts`, wie es auf
 * die Maschine kommt, in `page-design-apply.ts`.
 *
 * ── Vorgabe heißt: nichts gesetzt ──
 *
 * Eine Farbe `null`, ein Text ohne Eintrag, das Logo `hapm`: daraus entsteht
 * Byte für Byte die Seite, die HAPM ohne dieses Modul schriebe. Eine bestehende
 * Installation erkennt ihre Dateien deshalb nach dem Update weiter als die
 * eigenen. `tests/haproxy/page-design.test.ts` hält die Prüfsummen fest.
 *
 * ── Das Logo steckt in der Seite ──
 *
 * Eine Fehlerdatei ist eine vollständige HTTP-Antwort in einer Datei, und vor
 * einer Passwortsperre bekäme jede weitere Anfrage wieder die Abfrage. Ein Bild
 * zum Nachladen gibt es also nicht. Das eigene Logo geht als Data-URI in ein
 * `<img>`. Dort führt ein SVG kein Skript aus und lädt nichts nach, deshalb wird
 * es nicht als Markup in die Seite gesetzt.
 *
 * ── Die Größe ──
 *
 * HAProxy hält jede dieser Seiten in einem Puffer (`tune.bufsize`, 16384 Bytes,
 * die Grundkonfiguration setzt nichts anderes), von dem `tune.maxrewrite` (1024)
 * für Kopfzeilen frei bleiben soll. Gemessen mit HAProxy 2.4, 2.8, 3.0 und 3.4:
 *
 *  - Eine Fehlerdatei (`errorfile`, samt ihren Kopfzeilen) über rund 16290
 *    Bytes lehnt `haproxy -c` ab.
 *  - Die Passwortabfrage (`http-request return … file`) nimmt `haproxy -c` fast
 *    bis 16384 Bytes an. Ab 15361 warnt es („payload runs over the buffer space
 *    reserved to headers rewriting“), ab rund 16160 (2.4) bis 16180 (3.4)
 *    antwortet HAProxy dem Besucher mit 500, bei gültiger Konfiguration. Diese
 *    Grenze fängt also keine Prüfung ab, nur diese hier.
 *
 * `PAGE_MAX_BYTES` liegt unter beiden und unter der Warnung, mit gut 1 KB
 * Abstand zur 500. `scripts/verify-proxy-pages.ts` liefert ein Design genau an
 * dieser Grenze mit echtem HAProxy aus.
 *
 * Rein und ohne Umgebung: das Formular rechnet damit im Browser dieselbe Seite
 * aus wie die Route auf dem Server.
 */

import { ERROR_PAGE_STATUSES, isHexColor, type StaticTheme } from '@/ui/static/page';

/** Was eine fertige Seite samt Logo höchstens wiegen darf, in Bytes. */
export const PAGE_MAX_BYTES = 15_000;

export const LOGO_TYPES = {
  'image/svg+xml': 'SVG',
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/webp': 'WebP',
} as const;

export type LogoMime = keyof typeof LOGO_TYPES;

export type DesignLogo =
  | { kind: 'hapm' }
  | { kind: 'none' }
  /** `data` ist die Datei als Base64. `mime` kommt aus ihrem Inhalt, nie aus der Endung. */
  | { kind: 'custom'; mime: LogoMime; data: string };

export interface DesignColors {
  accent: string | null;
  background: string | null;
  text: string | null;
}

export interface ErrorTextOverride {
  title?: string;
  text?: string;
}

export interface LockTexts {
  title: string | null;
  subtitle: string | null;
  submit: string | null;
}

export interface PageDesign {
  colors: DesignColors;
  logo: DesignLogo;
  /** Schriftzug neben dem Logo. Leer heißt keiner. */
  brand: string;
  /** Zeile am Fuß jeder Seite. Leer heißt keine. */
  footer: string;
  /** Je Status nur, was von der Vorgabe abweicht. */
  errors: Partial<Record<number, ErrorTextOverride>>;
  lock: LockTexts;
}

export function defaultPageDesign(): PageDesign {
  return {
    colors: { accent: null, background: null, text: null },
    logo: { kind: 'hapm' },
    brand: '',
    footer: '',
    errors: {},
    lock: { title: null, subtitle: null, submit: null },
  };
}

/** Für ein Design in der Form, in der `parsePageDesign` es zurückgibt. */
export function isDefaultDesign(design: PageDesign): boolean {
  return JSON.stringify(design) === JSON.stringify(defaultPageDesign());
}

export const DESIGN_TEXT_LIMITS = {
  title: 80,
  text: 300,
  submit: 40,
  brand: 40,
  footer: 200,
} as const;

/** Mehr Base64 kann kein Logo tragen, das in die Seite passt. Vor dem Entpacken geprüft. */
const LOGO_BASE64_MAX = Math.ceil(PAGE_MAX_BYTES / 3) * 4;

/* ── Das Logo ── */

export function base64ToBytes(data: string): Uint8Array | null {
  if (data.length === 0 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Ein SVG beginnt mit `<svg`, davor höchstens XML-Kopf, Kommentare und ein
 * DOCTYPE ohne eigene Deklarationen. Ein DOCTYPE mit `[ … ]` fällt durch: dort
 * stünden Entitäten, und die braucht kein Logo.
 */
const SVG_START =
  /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE\s+svg[^>[]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i;

/**
 * Was eine Datei ist, nach ihren ersten Bytes. Die Endung und der Typ, den der
 * Browser meldet, sind Behauptungen dessen, der hochlädt.
 */
export function sniffLogoType(bytes: Uint8Array): LogoMime | null {
  const starts = (signature: number[], at = 0) => signature.every((byte, i) => bytes[at + i] === byte);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  const text = decodeUtf8(bytes);
  return text !== null && SVG_START.test(text) ? 'image/svg+xml' : null;
}

/**
 * Das Logo als Data-URI.
 *
 * Ein SVG ist Text, und Base64 macht jeden Text um ein Drittel länger. Es geht
 * deshalb auch prozentkodiert, und genommen wird die kürzere Fassung: bei 15 KB
 * für die ganze Seite entscheidet das, ob ein Logo hineinpasst. Am Bild ändert
 * keine der beiden etwas.
 */
export function logoDataUri(logo: { mime: LogoMime; data: string }): string {
  const base64 = `data:${logo.mime};base64,${logo.data}`;
  if (logo.mime !== 'image/svg+xml') return base64;

  const bytes = base64ToBytes(logo.data);
  const text = bytes ? decodeUtf8(bytes) : null;
  if (text === null) return base64;

  // Zurückgenommen wird nur, was in einem Attribut in Anführungszeichen ohne
  // Maskierung stehen darf. Der Apostroph wird kodiert: als `&#39;` wäre er länger.
  const encoded = encodeURIComponent(text)
    .replace(/%20/g, ' ')
    .replace(/%3D/g, '=')
    .replace(/%3A/g, ':')
    .replace(/%2F/g, '/')
    .replace(/%2C/g, ',')
    .replace(/%3B/g, ';')
    .replace(/'/g, '%27');
  const plain = `data:image/svg+xml;charset=utf-8,${encoded}`;
  return plain.length < base64.length ? plain : base64;
}

/** Was `ui/static/page.ts` aus dem Design braucht. */
export function designTheme(design: PageDesign): StaticTheme {
  return {
    accent: design.colors.accent,
    background: design.colors.background,
    text: design.colors.text,
    ...(design.logo.kind === 'hapm'
      ? {}
      : { logo: design.logo.kind === 'none' ? null : { src: logoDataUri(design.logo) } }),
    ...(design.brand ? { brand: design.brand } : {}),
    ...(design.footer ? { footer: design.footer } : {}),
  };
}

/* ── Prüfen ── */

export type DesignParse = { ok: true; design: PageDesign } | { ok: false; error: string };

const fail = (error: string): DesignParse => ({ ok: false, error });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Ein Text in einer Zeile. Steuerzeichen und Umbrüche werden zu einem
 * Leerzeichen: die Seite kennt an diesen Stellen keinen Absatz. Maskiert wird
 * beim Schreiben der Seite (`escapeHtml`), nicht hier.
 */
function cleanText(value: string): string {
  return value.replace(/[\p{Cc}\s]+/gu, ' ').trim();
}

/** `null` und `undefined` heißen Vorgabe. Ein leerer Text ist keine Vorgabe, sondern ein Fehler. */
function readText(value: unknown, name: string, max: number): { value: string | null } | { error: string } {
  if (value === null || value === undefined) return { value: null };
  if (typeof value !== 'string') return { error: `${name} ist kein Text.` };
  const text = cleanText(value);
  if (!text) return { error: `${name} darf nicht leer sein. Für den Text von HAPM setzen Sie das Feld zurück.` };
  if (text.length > max) return { error: `${name} ist länger als ${max} Zeichen.` };
  return { value: text };
}

/** Ein Feld, das leer bleiben darf (Schriftzug, Fußzeile). */
function readOptionalText(value: unknown, name: string, max: number): { value: string } | { error: string } {
  if (value === null || value === undefined) return { value: '' };
  if (typeof value !== 'string') return { error: `${name} ist kein Text.` };
  const text = cleanText(value);
  if (text.length > max) return { error: `${name} ist länger als ${max} Zeichen.` };
  return { value: text };
}

function readColor(value: unknown, name: string): { value: string | null } | { error: string } {
  if (value === null || value === undefined || value === '') return { value: null };
  if (!isHexColor(value)) return { error: `${name} ist keine Farbe in der Form #rrggbb.` };
  return { value: value.toLowerCase() };
}

function readLogo(value: unknown): { value: DesignLogo } | { error: string } {
  if (value === null || value === undefined) return { value: { kind: 'hapm' } };
  if (!isRecord(value)) return { error: 'Das Logo ist ungültig.' };
  if (value.kind === 'hapm' || value.kind === 'none') return { value: { kind: value.kind } };
  if (value.kind !== 'custom' || typeof value.data !== 'string') return { error: 'Das Logo ist ungültig.' };

  if (value.data.length > LOGO_BASE64_MAX) {
    return {
      error: `Das Logo ist zu groß. Die ganze Seite darf samt Logo höchstens ${PAGE_MAX_BYTES.toLocaleString('de-DE')} Bytes haben.`,
    };
  }
  const bytes = base64ToBytes(value.data);
  if (!bytes) return { error: 'Das Logo ließ sich nicht lesen.' };
  const mime = sniffLogoType(bytes);
  if (!mime) {
    return {
      error: 'Das Logo ist kein SVG, PNG, JPEG oder WebP. Geprüft wird der Inhalt der Datei, nicht ihre Endung.',
    };
  }
  return { value: { kind: 'custom', mime, data: value.data } };
}

/**
 * Aus einer Eingabe ein Design, oder der Grund, warum nicht.
 *
 * Die eine Prüfung für Formular, Route und gelesene Zeile. Sie sagt nichts über
 * die Größe der fertigen Seiten: die hängt an den Vorlagen und steht in
 * `design-pages.ts` (`designSizeError`).
 */
export function parsePageDesign(raw: unknown): DesignParse {
  if (!isRecord(raw)) return fail('Das Design ist ungültig.');

  const colorsIn = isRecord(raw.colors) ? raw.colors : {};
  const accent = readColor(colorsIn.accent, 'Die Akzentfarbe');
  if ('error' in accent) return fail(accent.error);
  const background = readColor(colorsIn.background, 'Der Hintergrund');
  if ('error' in background) return fail(background.error);
  const text = readColor(colorsIn.text, 'Die Textfarbe');
  if ('error' in text) return fail(text.error);

  const logo = readLogo(raw.logo);
  if ('error' in logo) return fail(logo.error);

  const brand = readOptionalText(raw.brand, 'Der Schriftzug', DESIGN_TEXT_LIMITS.brand);
  if ('error' in brand) return fail(brand.error);
  const footer = readOptionalText(raw.footer, 'Die Fußzeile', DESIGN_TEXT_LIMITS.footer);
  if ('error' in footer) return fail(footer.error);

  const errors: Partial<Record<number, ErrorTextOverride>> = {};
  if (raw.errors !== null && raw.errors !== undefined) {
    if (!isRecord(raw.errors)) return fail('Die Texte der Fehlerseiten sind ungültig.');
    for (const [key, value] of Object.entries(raw.errors)) {
      const status = Number(key);
      if (!ERROR_PAGE_STATUSES.includes(status)) return fail(`Für den Status ${key} gibt es keine Fehlerseite.`);
      if (value === null || value === undefined) continue;
      if (!isRecord(value)) return fail(`Die Texte für den Status ${status} sind ungültig.`);
      const title = readText(value.title, `Die Überschrift für ${status}`, DESIGN_TEXT_LIMITS.title);
      if ('error' in title) return fail(title.error);
      const body = readText(value.text, `Der Text für ${status}`, DESIGN_TEXT_LIMITS.text);
      if ('error' in body) return fail(body.error);
      const entry: ErrorTextOverride = {
        ...(title.value === null ? {} : { title: title.value }),
        ...(body.value === null ? {} : { text: body.value }),
      };
      if (Object.keys(entry).length > 0) errors[status] = entry;
    }
  }

  const lockIn = isRecord(raw.lock) ? raw.lock : {};
  const lockTitle = readText(lockIn.title, 'Die Überschrift der Passwortabfrage', DESIGN_TEXT_LIMITS.title);
  if ('error' in lockTitle) return fail(lockTitle.error);
  const lockSubtitle = readText(lockIn.subtitle, 'Der Text der Passwortabfrage', DESIGN_TEXT_LIMITS.text);
  if ('error' in lockSubtitle) return fail(lockSubtitle.error);
  const lockSubmit = readText(lockIn.submit, 'Die Beschriftung des Knopfs', DESIGN_TEXT_LIMITS.submit);
  if ('error' in lockSubmit) return fail(lockSubmit.error);

  return {
    ok: true,
    design: {
      colors: { accent: accent.value, background: background.value, text: text.value },
      logo: logo.value,
      brand: brand.value,
      footer: footer.value,
      errors,
      lock: { title: lockTitle.value, subtitle: lockSubtitle.value, submit: lockSubmit.value },
    },
  };
}

/* ── Das Design, das gerade gilt ──
 *
 * `renderErrorFile` und `lockPages` werden an Stellen aufgerufen, die kein
 * Design kennen und keines kennen sollen: der Vergleich mit der Datei auf der
 * Platte, die Seiten der Passwortsperre vor jedem Schreibvorgang
 * (`provision.ts`). Sie nehmen, was hier steht.
 *
 * Gesetzt wird es beim Start (`lib/bootstrap.ts`) und bei jedem Lesen und
 * Speichern (`page-design-store.ts`). Am globalen Objekt und nicht im Modul:
 * Next baut die Routen einzeln, und jede hätte sonst ihre eigene Fassung.
 * HAPM läuft als genau eine Instanz, das setzt auch der Lock in `provision.ts`
 * voraus.
 */

const holder = globalThis as typeof globalThis & { __hapmPageDesign?: PageDesign };

export function activeDesign(): PageDesign {
  return holder.__hapmPageDesign ?? defaultPageDesign();
}

export function setActiveDesign(design: PageDesign): void {
  holder.__hapmPageDesign = design;
}
