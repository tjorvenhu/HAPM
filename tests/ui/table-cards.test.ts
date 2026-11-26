import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Tabellen auf dem Handy (docs/oberflaeche.md, „Aufbau und Layout").
 *
 * Eine Tabelle mit mehr als zwei Spalten passt nicht auf ein Handy: sie liefe
 * waagerecht, und der Knopf in der letzten Spalte wäre nicht zu sehen. Sie
 * trägt deshalb `table-cards` (jede Zeile wird ein Block) und an jeder Zelle
 * ein `data-label`. Wer eine neue Tabelle baut und das vergisst, sieht es hier.
 */

const ROOT = process.cwd();

/** Tabellen mit eigener Lösung für schmale Schirme. Jede Zeile hier ist eine Entscheidung. */
const OWN_SOLUTION: { file: string; why: string }[] = [
  { file: 'app/(app)/reverse-proxy/logs/RunsView.tsx', why: 'eigene Karten nach der Breite des Bereichs (app/logs.css)' },
  { file: 'app/(app)/reverse-proxy/logs/HaproxyLogView.tsx', why: 'eigene Karten nach der Breite des Bereichs (app/logs.css)' },
  { file: 'components/crowdsec/CrowdsecLogView.tsx', why: 'eigene Karten nach der Breite des Bereichs (app/logs.css)' },
  { file: 'app/(app)/protokoll/EntriesView.tsx', why: 'dieselben Karten wie die Vorgänge (logs-runs in app/logs.css)' },
  { file: 'components/crowdsec/RulesPanel.tsx', why: 'drei schmale Spalten mit Schalter, bleiben sichtbar (.cs-rules)' },
  { file: 'app/(app)/dashboard/page.tsx', why: 'blendet Spalten aus, die Karten daneben zeigen dasselbe' },
  { file: 'app/(app)/reverse-proxy/import/page.tsx', why: 'Vorschau einer Konfiguration, wird am Schreibtisch gelesen' },
];

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

interface Table {
  file: string;
  line: number;
  classes: string;
  body: string;
}

function tables(): Table[] {
  const found: Table[] = [];
  for (const dir of ['app', 'components', 'ui']) {
    for (const full of sources(path.join(ROOT, dir))) {
      const text = readFileSync(full, 'utf8');
      const file = path.relative(ROOT, full).split(path.sep).join('/');
      for (const match of text.matchAll(/<table className="([^"]*)"/g)) {
        const end = text.indexOf('</table>', match.index);
        found.push({
          file,
          line: text.slice(0, match.index).split('\n').length,
          classes: match[1],
          body: text.slice(match.index, end < 0 ? undefined : end),
        });
      }
    }
  }
  return found;
}

const all = tables();
const own = new Set(OWN_SOLUTION.map((entry) => entry.file));

describe('Tabellen auf dem Handy', () => {
  it('findet überhaupt Tabellen', () => {
    expect(all.length).toBeGreaterThan(10);
  });

  it('jede Tabelle mit mehr als zwei Spalten wird zu Karten', () => {
    const open = all.filter(
      (table) => (table.body.match(/<th[\s>]/g) ?? []).length > 2 && !table.classes.split(' ').includes('table-cards') && !own.has(table.file)
    );
    expect(open.map((table) => `${table.file}:${table.line}`).join('\n')).toBe('');
  });

  it('in einer Tabelle aus Karten trägt jede Zelle ihr Etikett', () => {
    const open: string[] = [];
    for (const table of all) {
      if (!table.classes.split(' ').includes('table-cards')) continue;
      const lines = table.body.split('\n');
      lines.forEach((text, index) => {
        if (/<td(\s|>)/.test(text) && !/<td[^>]*data-label/.test(text)) open.push(`${table.file}:${table.line + index}`);
      });
    }
    expect(open.join('\n')).toBe('');
  });

  it('führt keine Ausnahme, deren Datei keine Tabelle mehr hat', () => {
    const files = new Set(all.map((table) => table.file));
    expect(OWN_SOLUTION.filter((entry) => !files.has(entry.file)).map((entry) => entry.file)).toEqual([]);
  });
});
