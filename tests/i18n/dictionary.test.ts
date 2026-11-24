import { describe, it, expect } from 'vitest';
import { collectKeys } from '@/scripts/i18n/scan';
import { en, PARTS } from '@/lib/i18n/en';

/**
 * Das englische Wörterbuch gegen den Quelltext.
 *
 * Geprüft wird nur, was über `t()`, `msg()`, `msgid()`, `rich()`,
 * `translate(locale, …)` und `plural(…, { one, other })` läuft. Eine Datei, die
 * noch deutsche Texte ohne `t()` führt, macht den Test nicht rot: was fehlt,
 * zählt `scripts/i18n-report.ts`. So bleibt er grün, während die Bereiche
 * nacheinander umgestellt werden.
 */

const { keys, dynamic } = collectKeys(process.cwd());
const used = new Set(keys.map((entry) => entry.key));

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

function list(lines: string[]): string {
  return lines.length ? `\n  ${lines.join('\n  ')}\n` : '';
}

describe('Wörterbuch Englisch', () => {
  it('findet überhaupt Schlüssel, damit ein kaputter Scan den Test nicht grün macht', () => {
    expect(keys.length).toBeGreaterThan(200);
    expect(used.has('Abmelden')).toBe(true);
  });

  it('hat keine zusammengesetzten Schlüssel (Template mit ${} oder +)', () => {
    expect(list(dynamic.map((d) => `${d.file}:${d.line}  ${d.text}`))).toBe('');
  });

  it('übersetzt jeden Schlüssel aus dem Quelltext', () => {
    const missing = new Map<string, string>();
    for (const entry of keys) {
      if (!Object.hasOwn(en, entry.key) && !missing.has(entry.key)) missing.set(entry.key, `${entry.file}:${entry.line}`);
    }
    expect(list([...missing].map(([key, where]) => `${JSON.stringify(key)}  (${where})`))).toBe('');
  });

  it('führt keine Einträge, die niemand mehr benutzt', () => {
    const unused = Object.keys(en).filter((key) => !used.has(key));
    expect(list(unused.map((key) => JSON.stringify(key)))).toBe('');
  });

  it('hat in Schlüssel und Übersetzung dieselben Platzhalter', () => {
    const wrong = Object.entries(en)
      .filter(([key, value]) => placeholders(key).join() !== placeholders(value).join())
      .map(([key, value]) => `${JSON.stringify(key)} → ${JSON.stringify(value)}`);
    expect(list(wrong)).toBe('');
  });

  it('nennt jeden Schlüssel in genau einer Datei', () => {
    const seen = new Map<string, string>();
    const doubled: string[] = [];
    for (const [part, dictionary] of Object.entries(PARTS)) {
      for (const key of Object.keys(dictionary)) {
        const before = seen.get(key);
        if (before) doubled.push(`${JSON.stringify(key)} in ${before} und ${part}`);
        else seen.set(key, part);
      }
    }
    expect(list(doubled)).toBe('');
  });

  it('übersetzt nicht leer und ohne Gedankenstrich', () => {
    const bad = Object.entries(en)
      .filter(([, value]) => !value.trim() || / [–—] /.test(value))
      .map(([key, value]) => `${JSON.stringify(key)} → ${JSON.stringify(value)}`);
    expect(list(bad)).toBe('');
  });
});
