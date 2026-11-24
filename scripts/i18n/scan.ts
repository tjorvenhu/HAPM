/**
 * Liest den Quelltext und findet die Texte der Oberfläche: die, die schon über
 * `t()`/`msg()` laufen (für `tests/i18n/dictionary.test.ts`), und die, die es
 * noch nicht tun (für `scripts/i18n-report.ts`).
 *
 * Über den Parser von TypeScript und nicht über reguläre Ausdrücke: Kommentare,
 * JSX-Text und Zeichenketten mit Klammern darin bringen einen regulären
 * Ausdruck durcheinander, und dann meldete der Test Schlüssel, die es nicht gibt.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

/** Wo Texte der Oberfläche stehen können. */
export const SOURCE_DIRS = ['app', 'components', 'lib', 'ui'];

/** Das Wörterbuch selbst ist kein Aufruf von `t()`. */
const SKIP = [`lib${sep}i18n${sep}en${sep}`];

/** Die Aufrufe, deren erstes Argument ein Schlüssel ist. */
const KEY_FIRST = new Set(['t', 'msg', 'msgid', 'rich']);

export interface FoundKey {
  key: string;
  file: string;
  line: number;
}

export interface DynamicKey {
  file: string;
  line: number;
  text: string;
}

export function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.d.ts')) out.push(path);
    }
  };
  for (const dir of SOURCE_DIRS) walk(join(root, dir));
  return out.filter((file) => !SKIP.some((part) => relative(root, file).includes(part)));
}

function parse(file: string): ts.SourceFile {
  const text = readFileSync(file, 'utf8');
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

/** Die Argumente eines Aufrufs, die Schlüssel sind. */
function keyArguments(call: ts.CallExpression): ts.Expression[] {
  const name = calleeName(call);
  if (!name) return [];
  if (KEY_FIRST.has(name)) return call.arguments.slice(0, 1);
  if (name === 'translate') return call.arguments.slice(1, 2);
  if (name === 'plural') {
    const out: ts.Expression[] = [];
    for (const arg of call.arguments) {
      if (!ts.isObjectLiteralExpression(arg)) continue;
      for (const prop of arg.properties) {
        if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && ['one', 'other'].includes(prop.name.text)) {
          out.push(prop.initializer);
        }
      }
    }
    return out;
  }
  return [];
}

/**
 * Die Schlüssel in einem Argument: ein Literal, oder beide Zweige von
 * `a ? 'x' : 'y'`. Ein Template mit `${}` ist kein Schlüssel, sondern ein
 * Fehler: der Text entstünde erst zur Laufzeit.
 */
function literalKeys(node: ts.Expression, onDynamic: (node: ts.Node) => void): ts.StringLiteralLike[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node];
  if (ts.isParenthesizedExpression(node)) return literalKeys(node.expression, onDynamic);
  if (ts.isConditionalExpression(node)) {
    return [...literalKeys(node.whenTrue, onDynamic), ...literalKeys(node.whenFalse, onDynamic)];
  }
  if (ts.isTemplateExpression(node)) onDynamic(node);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) onDynamic(node);
  return [];
}

/** Alle Schlüssel, die über `t`, `msg`, `msgid`, `rich`, `translate` und `plural` laufen. */
export function collectKeys(root: string): { keys: FoundKey[]; dynamic: DynamicKey[] } {
  const keys: FoundKey[] = [];
  const dynamic: DynamicKey[] = [];
  for (const file of sourceFiles(root)) {
    const source = parse(file);
    const where = (node: ts.Node) => ({
      file: relative(root, file).split(sep).join('/'),
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    });
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        for (const arg of keyArguments(node)) {
          for (const literal of literalKeys(arg, (bad) => dynamic.push({ ...where(bad), text: bad.getText(source) }))) {
            keys.push({ key: literal.text, ...where(literal) });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { keys, dynamic };
}

/* ── Was noch nicht über t() läuft ── */

const GERMAN_WORDS =
  /\b(der|die|das|und|nicht|ist|ein|eine|einen|einem|mit|für|wird|werden|kein|keine|bitte|sie|ihr|ihre|zu|im|auf|von|den|dem|des|noch|schon|oder|wenn|nur|gibt|sind|bei|nach|über|wurde|kann|lässt|sich|hier|alle|neue?n?|zur|zum|als|aus|steht|fehlt|ungültig)\b/i;

/** Sieht der Text aus wie ein deutscher Satz oder eine Beschriftung? Grob, mit Absicht. */
export function looksGerman(text: string): boolean {
  const value = text.trim();
  if (value.length < 2 || !/[a-zäöüß]/i.test(value)) return false;
  if (/^[\w.-]+$/.test(value) && !/[äöüÄÖÜß]/.test(value)) return false; // Kennung, Klasse, Pfad
  if (/^(\/|https?:|\.|#|--)/.test(value)) return false;
  if (/[äöüÄÖÜß]/.test(value)) return true;
  return /\s/.test(value) && GERMAN_WORDS.test(value);
}

/** Attribute, deren Wert immer jemand liest. */
const VISIBLE_ATTRIBUTES = new Set([
  'title', 'placeholder', 'aria-label', 'alt', 'label', 'subtitle', 'data-tooltip', 'confirmLabel',
  'cancelLabel', 'message', 'emptyText', 'pendingText', 'hint', 'description',
]);

/** Aufrufe, deren Text niemand in der Oberfläche liest. */
const IGNORED_CALLS = new Set(['log', 'warn', 'error', 'info', 'debug', 'require', 'import', 'logAudit']);

export interface Untranslated {
  file: string;
  line: number;
  text: string;
  /** `message`: Meldung des Servers (`ApiError`, `fail`), sonst Oberfläche. */
  kind: 'ui' | 'message';
}

function isKeyArgument(node: ts.Node): boolean {
  let current: ts.Node = node;
  while (current.parent && (ts.isConditionalExpression(current.parent) || ts.isParenthesizedExpression(current.parent))) {
    current = current.parent;
  }
  const parent = current.parent;
  if (!parent) return false;
  if (ts.isCallExpression(parent)) return keyArguments(parent).includes(current as ts.Expression);
  if (ts.isPropertyAssignment(parent) && parent.parent && ts.isObjectLiteralExpression(parent.parent)) {
    const call = parent.parent.parent;
    return Boolean(call && ts.isCallExpression(call) && calleeName(call) === 'plural');
  }
  return false;
}

function insideIgnoredCall(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isCallExpression(current)) {
      const name = calleeName(current);
      if (name && IGNORED_CALLS.has(name)) return true;
    }
    // Audit-Details bleiben deutsch, siehe docs/i18n.md.
    if (ts.isPropertyAssignment(current) && ts.isIdentifier(current.name) && current.name.text === 'details') return true;
    if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current)) return true;
  }
  return false;
}

function messageKind(node: ts.Node): Untranslated['kind'] {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isNewExpression(current) && ts.isIdentifier(current.expression) && /^(ApiError|ConflictError)$/.test(current.expression.text)) {
      return 'message';
    }
    if (ts.isCallExpression(current) && calleeName(current) === 'fail') return 'message';
    if (ts.isFunctionLike(current)) break;
  }
  return 'ui';
}

/** Die Texte einer Datei, die deutsch aussehen und nicht über `t()`/`msg()` laufen. */
export function untranslatedIn(root: string, file: string): Untranslated[] {
  const source = parse(file);
  const out: Untranslated[] = [];
  const add = (node: ts.Node, text: string) => {
    out.push({
      file: relative(root, file).split(sep).join('/'),
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      text: text.replace(/\s+/g, ' ').trim(),
      kind: messageKind(node),
    });
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      const text = node.getText(source).replace(/\s+/g, ' ').trim();
      if (/[a-zA-ZäöüÄÖÜß]{2,}/.test(text)) add(node, text);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const attribute = ts.isJsxAttribute(node.parent) ? node.parent.name.getText(source) : null;
      const visible = attribute !== null && VISIBLE_ATTRIBUTES.has(attribute) && /[a-zA-Z]{2,}/.test(node.text);
      if ((visible || looksGerman(node.text)) && !isKeyArgument(node) && !insideIgnoredCall(node)) add(node, node.text);
    } else if (ts.isTemplateExpression(node)) {
      const text = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join('{…}');
      if (looksGerman(text) && !isKeyArgument(node) && !insideIgnoredCall(node)) add(node, text);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

export function collectUntranslated(root: string): Untranslated[] {
  return sourceFiles(root)
    .filter((file) => !file.includes(`lib${sep}i18n${sep}`))
    .flatMap((file) => untranslatedIn(root, file));
}
