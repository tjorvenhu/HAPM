import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';
import { LONG_TEXT } from '@/ui/primitives/hint-text';

/**
 * Eine lange Erklärung steht hinter dem „i" (`InfoHint`), nicht als Text unter
 * Titel oder Feld. Die Schwelle ist `LONG_TEXT`.
 *
 * Geprüft wird, was sich am Quelltext ablesen lässt: ein Element mit einer der
 * Klassen aus `CLASSES`, dessen Inhalt ein fester Text ist (`t('…')` oder
 * Text im JSX). Was mit `rich()` Links oder Code trägt, bleibt sichtbar: in
 * einem Tooltip ginge es verloren. Was in einem `InfoHint` steht, zählt nicht.
 *
 * Sichtbar bleiben darf auch, was man vor dem Klick wissen muss (eine Folge,
 * eine Warnung) oder was ein Zustand ist. Jede solche Stelle steht in
 * `ALLOWED`, mit dem Grund. Eine Ausnahme ohne Fundstelle lässt den Test
 * scheitern, damit die Liste nicht veraltet.
 */

const ROOTS = ['app', 'components', 'ui'];
const SKIP = [join('app', 'api')];
const CLASSES = /(^|[\s"'`])(page-subtitle|card-subtitle|form-section-sub|form-hint)(?=$|[\s"'`])/;

interface Allowed {
  file: string;
  text: string;
  reason: string;
}

const ALLOWED: Allowed[] = [];

function sources(dir: string): string[] {
  if (SKIP.includes(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.tsx') ? [path] : [];
  });
}

function squeeze(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function tagName(node: ts.JsxElement | ts.JsxSelfClosingElement): string {
  return (ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName).getText();
}

/** Die festen Texte in einem Element, ohne das, was ein `InfoHint` trägt. */
function fixedTexts(node: ts.Node, out: string[]): void {
  if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && tagName(node) === 'InfoHint') return;
  if (ts.isJsxText(node)) {
    const text = squeeze(node.text);
    if (text) out.push(text);
  }
  if (ts.isCallExpression(node) && node.expression.getText() === 't') {
    const first = node.arguments[0];
    if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) out.push(squeeze(first.text));
  }
  node.forEachChild((child) => fixedTexts(child, out));
}

interface Finding {
  file: string;
  line: number;
  text: string;
}

function findings(file: string): Finding[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node)) {
      const className = node.openingElement.attributes.properties.find(
        (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText() === 'className'
      );
      if (className && CLASSES.test(className.getText())) {
        const texts: string[] = [];
        node.children.forEach((child) => fixedTexts(child, texts));
        for (const text of texts) {
          if (text.length > LONG_TEXT) {
            const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
            found.push({ file: file.replace(/\\/g, '/'), line, text });
          }
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(source);
  return found;
}

const all = ROOTS.flatMap(sources).flatMap(findings);
const isAllowed = (finding: Finding) => ALLOWED.some((entry) => entry.file === finding.file && entry.text === finding.text);

describe('lange Erklärungen', () => {
  it('stehen hinter dem „i" und nicht unter Titel oder Feld', () => {
    const open = all.filter((finding) => !isAllowed(finding));
    expect(open.map((finding) => `${finding.file}:${finding.line}  (${finding.text.length})  ${finding.text}`).join('\n')).toBe('');
  });

  it('führt keine Ausnahme, die es nicht mehr gibt', () => {
    const stale = ALLOWED.filter((entry) => !all.some((finding) => finding.file === entry.file && finding.text === entry.text));
    expect(stale.map((entry) => `${entry.file}  ${entry.text}`).join('\n')).toBe('');
  });

  it('begründet jede Ausnahme', () => {
    expect(ALLOWED.filter((entry) => entry.reason.trim().length < 10).map((entry) => entry.text)).toEqual([]);
  });
});
