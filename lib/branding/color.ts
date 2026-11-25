/**
 * Aus einer Akzentfarbe die Werte, die die Oberfläche braucht.
 *
 * ── Warum die Farbe abgedunkelt wird und nicht die Schrift dunkel ──
 *
 * Auf dem Akzent steht weiße Schrift (`--primary-fg`), und derselbe Wert steht
 * auf den Knöpfen „Löschen" und „Warnung". Eine helle Akzentfarbe mit dunkler
 * Schrift hieße, jede dieser Stellen einzeln umzustellen. Der Akzent ist
 * außerdem Textfarbe auf weißer Fläche (Links, aktive Reiter): dafür muss er
 * genauso dunkel sein. Eine Farbe, gegen die Weiß nicht auf 4,5:1 kommt
 * (WCAG AA für normale Schrift), wird deshalb in OKLCH so weit abgedunkelt,
 * bis es reicht. Farbton und Buntheit bleiben, soweit sRGB sie trägt.
 *
 * Rein und ohne Umgebung: das Formular rechnet damit im Browser dieselbe
 * Vorschau aus wie das Layout auf dem Server.
 */

import { contrastRatio, isHexColor } from '@/ui/static/page';

export { contrastRatio, isHexColor };

/** Das Grün von HAPM, wie es in `ui/css/tool-vocabulary.css` steht. */
export const HAPM_ACCENT = '#1a5c4c';

/** WCAG AA für normale Schrift. */
export const MIN_CONTRAST = 4.5;

const WHITE = '#ffffff';

type Rgb = [number, number, number];
type Oklch = { l: number; c: number; h: number };

function hexToRgb(hex: string): Rgb {
  return [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255) as Rgb;
}

function rgbToHex(rgb: Rgb): string {
  return `#${rgb
    .map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0'))
    .join('')}`;
}

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const fromLinear = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

function rgbToOklch(rgb: Rgb): Oklch {
  const [r, g, b] = rgb.map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return { l: L, c: Math.hypot(A, B), h: h < 0 ? h + 360 : h };
}

/** Linear, ohne Beschneiden: Werte außerhalb von 0..1 heißen „nicht in sRGB". */
function oklchToLinear({ l, c, h }: Oklch): Rgb {
  const rad = (h * Math.PI) / 180;
  const A = c * Math.cos(rad);
  const B = c * Math.sin(rad);
  const l_ = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m_ = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s_ = (l - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const inGamut = (rgb: Rgb) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** Eine OKLCH-Farbe als Hex. Passt sie nicht in sRGB, sinkt die Buntheit, bis sie passt. */
function oklchToHex(color: Oklch): string {
  let { c } = color;
  if (!inGamut(oklchToLinear(color))) {
    let low = 0;
    let high = c;
    for (let i = 0; i < 24; i++) {
      const mid = (low + high) / 2;
      if (inGamut(oklchToLinear({ ...color, c: mid }))) low = mid;
      else high = mid;
    }
    c = low;
  }
  return rgbToHex(oklchToLinear({ ...color, c }).map(fromLinear) as Rgb);
}

/** `share` ist der Anteil von `to`, gemischt in sRGB wie in den Stylesheets. */
function mix(from: string, to: string, share: number): string {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  return rgbToHex(a.map((v, i) => v + (b[i] - v) * share) as Rgb);
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex).map((v) => Math.round(v * 255));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Die hellste Fassung derselben Farbe, gegen die Weiß mindestens `MIN_CONTRAST`
 * erreicht. Ist die Farbe schon dunkel genug, bleibt sie, wie sie ist.
 */
export function readableAccent(hex: string): string {
  if (contrastRatio(hex, WHITE) >= MIN_CONTRAST) return hex;
  const start = rgbToOklch(hexToRgb(hex));
  let low = 0;
  let high = start.l;
  let best = oklchToHex({ ...start, l: 0 });
  for (let i = 0; i < 30; i++) {
    const mid = (low + high) / 2;
    const candidate = oklchToHex({ ...start, l: mid });
    if (contrastRatio(candidate, WHITE) >= MIN_CONTRAST) {
      best = candidate;
      low = mid;
    } else {
      high = mid;
    }
  }
  return best;
}

export interface AccentPalette {
  /** Die gewählte Farbe. */
  chosen: string;
  /** Was als `--accent` gilt: die gewählte Farbe oder ihre dunklere Fassung. */
  accent: string;
  hover: string;
  /** Helle Fläche im Farbton, etwa hinter dem aktiven Eintrag. */
  light: string;
  subtle: string;
  glow: string;
  /** Kontrast von Weiß auf der gewählten Farbe. */
  chosenContrast: number;
  /** Kontrast von Weiß auf `accent`. */
  contrast: number;
  /** Ob `accent` dunkler ist als die gewählte Farbe. */
  adjusted: boolean;
  /** Farbton in OKLCH, für die Neutralskala. `null` bei einer fast grauen Farbe. */
  hue: number | null;
}

/** Wie weit sich der Hover von der Farbe entfernt, in OKLCH-Helligkeit. */
const HOVER_STEP = 0.06;

export function deriveAccent(chosen: string): AccentPalette {
  const accent = readableAccent(chosen);
  const base = rgbToOklch(hexToRgb(accent));

  // Wie bei HAPM heller beim Überfahren, solange Weiß darauf lesbar bleibt. Sonst dunkler.
  const lighter = oklchToHex({ ...base, l: Math.min(1, base.l + HOVER_STEP) });
  const hover =
    contrastRatio(lighter, WHITE) >= MIN_CONTRAST ? lighter : oklchToHex({ ...base, l: Math.max(0, base.l - HOVER_STEP) });

  return {
    chosen,
    accent,
    hover,
    light: mix(accent, WHITE, 0.9),
    subtle: rgba(accent, 0.06),
    glow: rgba(accent, 0.12),
    chosenContrast: contrastRatio(chosen, WHITE),
    contrast: contrastRatio(accent, WHITE),
    adjusted: accent !== chosen,
    hue: base.c < 0.03 ? null : Math.round(base.h),
  };
}

/**
 * Die Neutralskala aus `ui/css/08-shell-tokens.css` im Farbton des Akzents. Die
 * Buntheit bleibt so gering wie dort: der Ton ist zu ahnen, nicht zu sehen.
 */
export function neutralScale(hue: number | null): Record<string, string> {
  const steps: [string, number, number][] = [
    ['50', 0.985, 0.003],
    ['100', 0.967, 0.003],
    ['150', 0.952, 0.003],
    ['200', 0.922, 0.003],
    ['300', 0.87, 0.006],
    ['500', 0.556, 0.006],
    ['600', 0.439, 0.006],
    ['800', 0.269, 0.006],
    ['950', 0.145, 0.003],
  ];
  return Object.fromEntries(
    steps.map(([name, l, c]) => [`--n-${name}`, hue === null ? `oklch(${l} 0 0)` : `oklch(${l} ${c} ${hue})`])
  );
}

/** Alle Werte, die eine eigene Akzentfarbe an der Wurzel setzt. */
export function accentVariables(chosen: string): Record<string, string> {
  const palette = deriveAccent(chosen);
  return {
    '--accent': palette.accent,
    '--accent-hover': palette.hover,
    '--accent-light': palette.light,
    '--accent-subtle': palette.subtle,
    '--accent-glow': palette.glow,
    // Getönte Flächen, die ohne eigene Farbe `--success` nehmen (`app/setup/setup.css`).
    '--brand-tint': palette.accent,
    ...neutralScale(palette.hue),
    '--overlay': palette.hue === null ? 'oklch(0.145 0 0 / 0.32)' : `oklch(0.145 0.003 ${palette.hue} / 0.32)`,
  };
}
