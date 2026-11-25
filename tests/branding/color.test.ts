import { describe, it, expect } from 'vitest';
import {
  accentVariables,
  contrastRatio,
  deriveAccent,
  HAPM_ACCENT,
  MIN_CONTRAST,
  neutralScale,
  readableAccent,
} from '@/lib/branding/color';

describe('readableAccent', () => {
  it('lässt eine Farbe stehen, auf der weiße Schrift lesbar ist', () => {
    expect(readableAccent(HAPM_ACCENT)).toBe(HAPM_ACCENT);
    expect(readableAccent('#1d4ed8')).toBe('#1d4ed8');
  });

  it('dunkelt eine helle Farbe ab, bis Weiß darauf 4,5:1 erreicht', () => {
    for (const light of ['#ffd400', '#7dd3fc', '#22c55e', '#ff6b6b', '#ffffff', '#e5e7eb']) {
      const fixed = readableAccent(light);
      expect(fixed).not.toBe(light);
      expect(contrastRatio(fixed, '#ffffff')).toBeGreaterThanOrEqual(MIN_CONTRAST);
      // Nicht dunkler als nötig: bis fast an die Grenze.
      expect(contrastRatio(fixed, '#ffffff')).toBeLessThan(MIN_CONTRAST + 0.35);
    }
  });

  it('behält den Farbton: ein helles Gelb bleibt gelblich, kein Grau', () => {
    const fixed = readableAccent('#ffd400');
    const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(fixed.slice(at, at + 2), 16));
    expect(r).toBeGreaterThan(b + 30);
    expect(g).toBeGreaterThan(b + 30);
  });
});

describe('deriveAccent', () => {
  it('nennt den Kontrast der gewählten und der benutzten Farbe', () => {
    const palette = deriveAccent('#38bdf8');
    expect(palette.adjusted).toBe(true);
    expect(palette.chosen).toBe('#38bdf8');
    expect(palette.chosenContrast).toBeLessThan(MIN_CONTRAST);
    expect(palette.contrast).toBeGreaterThanOrEqual(MIN_CONTRAST);
  });

  it('hält auch den Hover lesbar', () => {
    for (const color of [HAPM_ACCENT, '#ffd400', '#7c3aed', '#000000', '#374151']) {
      const palette = deriveAccent(color);
      expect(contrastRatio(palette.hover, '#ffffff')).toBeGreaterThanOrEqual(MIN_CONTRAST);
      expect(palette.hover).not.toBe(palette.accent);
    }
  });

  it('hellt beim Grün von HAPM auf, wie das Stylesheet', () => {
    const palette = deriveAccent(HAPM_ACCENT);
    expect(palette.adjusted).toBe(false);
    expect(contrastRatio(palette.hover, '#ffffff')).toBeLessThan(palette.contrast);
  });

  it('leitet helle Fläche und durchscheinende Töne ab', () => {
    const palette = deriveAccent('#1d4ed8');
    expect(contrastRatio(palette.light, '#ffffff')).toBeLessThan(1.25);
    expect(palette.subtle).toBe('rgba(29, 78, 216, 0.06)');
    expect(palette.glow).toBe('rgba(29, 78, 216, 0.12)');
  });

  it('kennt den Farbton, außer bei Grau', () => {
    expect(deriveAccent(HAPM_ACCENT).hue).toBeGreaterThan(160);
    expect(deriveAccent(HAPM_ACCENT).hue).toBeLessThan(185);
    expect(deriveAccent('#555555').hue).toBeNull();
  });
});

describe('neutralScale und accentVariables', () => {
  it('trifft beim Grün von HAPM die Werte des Stylesheets bis auf den Farbton', () => {
    expect(neutralScale(175)['--n-150']).toBe('oklch(0.952 0.003 175)');
    expect(neutralScale(null)['--n-950']).toBe('oklch(0.145 0 0)');
  });

  it('setzt jede Variable, die der Rahmen vom Akzent liest', () => {
    const vars = accentVariables('#7c3aed');
    for (const name of ['--accent', '--accent-hover', '--accent-light', '--accent-subtle', '--accent-glow', '--brand-tint', '--n-50', '--n-950', '--overlay']) {
      expect(vars[name]).toBeTruthy();
    }
    expect(Object.values(vars).join(';')).not.toMatch(/[<>{}]/);
  });
});
