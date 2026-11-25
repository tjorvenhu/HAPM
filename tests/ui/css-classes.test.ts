import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Fängt zwei Fehler an Klassennamen ab, die TypeScript nicht sieht.
 *
 * Der erste: eine Seite benutzt eine Klasse, die es nirgends gibt. Die Regeln
 * stehen an drei Stellen (`ui/css/`, `app/globals.css`, `app/hapm.css`, dazu
 * die Stylesheets einzelner Seiten in `PAGE_CSS`), und alle außer `ui/css/`
 * kennen nur, was einzelne Seiten brauchen. Eine Klasse, die in keiner davon
 * steht, fällt beim Schreiben nicht auf: das sieht man erst im
 * Browser.
 *
 * Der zweite: `.alert` trägt Abstand, Radius und Anordnung, `.alert-info` nur
 * die Farben. `className="alert-info"` allein ergibt ein farbiges Rechteck ohne
 * Abstand.
 */

const UI_CSS = 'ui/css';

/** Eine Datei aus `ui/css` samt allem, was sie einbindet (`tool.css` zählt nur Teile auf). */
function uiCss(entry: string): string {
  const text = readFileSync(join(UI_CSS, entry), 'utf8');
  const parts = [...text.matchAll(/@import "\.\/([^"]+)"/g)].map((m) => uiCss(m[1]));
  return [text, ...parts].join('\n');
}

const GLOBALS = readFileSync('app/globals.css', 'utf8');
/** Stylesheets einzelner Seiten, eingebunden in deren `page.tsx`. */
const PAGE_CSS = ['app/logs.css', 'app/setup/setup.css', 'app/branding.css'];

const CSS = [
  uiCss('tool.css'),
  GLOBALS,
  readFileSync('app/hapm.css', 'utf8'),
  ...PAGE_CSS.map((file) => readFileSync(file, 'utf8')),
].join('\n');

const DEFINED = new Set([...CSS.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));

/** Abwandlungen, deren Grundklasse die Anordnung trägt. */
const NEEDS_BASE: Record<string, string[]> = {
  alert: ['alert-info', 'alert-warning', 'alert-danger', 'alert-success'],
  btn: ['btn-primary', 'btn-secondary', 'btn-danger', 'btn-ghost', 'btn-sm', 'btn-icon'],
  'badge-status': ['badge-success', 'badge-danger', 'badge-warning', 'badge-neutral'],
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith('.tsx')) out.push(path);
  }
  return out;
}

const FILES = [...walk('app'), ...walk('components')];

interface Usage {
  file: string;
  raw: string;
  classes: string[];
}

/** Jedes className="..." und className={`...`}, ohne die eingesetzten Ausdrücke. */
function collectUsages(): Usage[] {
  const usages: Usage[] = [];
  for (const file of FILES) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
      const raw = match[1] ?? match[2] ?? '';
      const literal = raw.replace(/\$\{[^}]*\}/g, ' ');
      usages.push({ file, raw, classes: literal.split(/\s+/).filter(Boolean) });
    }
  }
  return usages;
}

const USAGES = collectUsages();

describe('CSS-Klassen', () => {
  it('findet überhaupt Stellen, damit ein kaputter Ausdruck den Test nicht grün macht', () => {
    expect(USAGES.length).toBeGreaterThan(100);
  });

  it('bindet das Design aus ui/css ein', () => {
    expect(GLOBALS).toContain('@import "../ui/css/tool.css";');
    expect(DEFINED.has('app-shell__sidebar')).toBe(true);
    expect(DEFINED.has('viz-card')).toBe(true);
  });

  it('lädt keine Schrift von einem fremden Server', () => {
    expect(GLOBALS).not.toMatch(/@import\s+url\(/);
  });

  it('benutzt nur Klassen, die ui/css, globals.css oder hapm.css kennt', () => {
    const missing = new Map<string, string[]>();
    for (const usage of USAGES) {
      for (const cls of usage.classes) {
        if (!DEFINED.has(cls)) {
          missing.set(cls, [...(missing.get(cls) ?? []), usage.file]);
        }
      }
    }
    expect(
      [...missing].map(([cls, files]) => `.${cls} (${files[0]})`),
      'Klassen ohne Definition'
    ).toEqual([]);
  });

  it.each(Object.entries(NEEDS_BASE))(
    'setzt eine Abwandlung von %s nie ohne die Grundklasse',
    (base, modifiers) => {
      const offenders: string[] = [];

      for (const usage of USAGES) {
        const hasBase = usage.classes.includes(base) || usage.raw.includes(`${base} `);
        const usedModifier = usage.classes.find((c) => modifiers.includes(c));
        if (usedModifier && !hasBase) {
          offenders.push(`${usage.file}: "${usage.raw.trim()}"`);
        }
      }

      expect(offenders, `Abwandlung ohne Grundklasse "${base}"`).toEqual([]);
    }
  );
});
