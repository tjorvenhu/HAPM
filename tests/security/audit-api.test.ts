import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Die Routen des Protokolls unter `/api/audit/**` und sein Abruf über die
 * interne API.
 *
 * Das Protokoll ist die Stelle, an der man nachliest, was ein gestohlener Key
 * getan hat. Deshalb gilt, was diese Datei festhält: lesen geht mit Sitzung
 * oder mit Key, aber Aufbewahrung und Weiterleitung ändert nur eine Sitzung.
 * Ein Key, der die Aufbewahrung kürzen oder die Weiterleitung umbiegen könnte,
 * räumte hinter sich auf.
 */

const DIR = 'app/api/audit';

function files(dir: string, match: (name: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files(path, match, out);
    else if (match(entry)) out.push(path);
  }
  return out;
}

function handlers(source: string): { method: string; body: string }[] {
  const starts = [...source.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/g)];
  return starts.map((match, index) => ({
    method: match[1],
    body: source.slice(match.index, starts[index + 1]?.index ?? source.length),
  }));
}

const ROUTES = files(DIR, (name) => name === 'route.ts');
const CASES = ROUTES.flatMap((file) => handlers(readFileSync(file, 'utf8')).map((handler) => ({ file, ...handler })));
const WRITING = CASES.filter((c) => c.method !== 'GET');

describe('die Routen des Protokolls', () => {
  it('findet die Routen, damit ein kaputter Pfad die Suite nicht grün macht', () => {
    expect(ROUTES.map((file) => file.split('\\').join('/')).sort()).toEqual([
      'app/api/audit/export/route.ts',
      'app/api/audit/route.ts',
      'app/api/audit/settings/route.ts',
      'app/api/audit/test/route.ts',
    ]);
    expect(WRITING.length).toBe(3);
  });

  it.each(CASES)('$file $method verlangt eine Sitzung', ({ body }) => {
    expect(body).toContain('await requireSession()');
    expect(body).not.toContain('requireServiceToken');
  });

  it.each(WRITING)('$file $method prüft CSRF und Sitzung, bevor es den Rumpf liest', ({ body }) => {
    const csrf = body.indexOf('await requireCsrf(request)');
    const session = body.indexOf('await requireSession()');
    const read = body.indexOf('await jsonBody');
    expect(csrf).toBeGreaterThan(-1);
    expect(csrf).toBeLessThan(session);
    expect(read).toBeGreaterThan(session);
  });

  it('der Export ist ein POST: er schreibt ins Protokoll und verlangt deshalb den CSRF-Token', () => {
    const source = readFileSync(join(DIR, 'export', 'route.ts'), 'utf8');
    expect(handlers(source).map((handler) => handler.method)).toEqual(['POST']);
  });
});

describe('was ein API-Key am Protokoll darf', () => {
  it('liest über die interne API, und sonst nichts', () => {
    const source = readFileSync('app/api/internal/audit/route.ts', 'utf8');
    expect(handlers(source).map((handler) => handler.method)).toEqual(['GET']);
    expect(source).toContain('readAuditLog');
  });

  /** Die Funktionen, die Aufbewahrung und Weiterleitung ändern oder ein Ziel ansprechen. */
  const SESSION_ONLY = ['audit-log/actions', 'audit-log/settings', 'changeAuditSettings', 'sendForwardTest', 'startAuditExport'];

  const KEY_SIDE = [...files('app/api/internal', (name) => name.endsWith('.ts')), ...files('app/api/mcp', (name) => name.endsWith('.ts')), ...files('lib/mcp', (name) => name.endsWith('.ts'))];

  it('findet die Dateien, die mit einem Key erreichbar sind', () => {
    expect(KEY_SIDE.length).toBeGreaterThan(20);
  });

  it.each(KEY_SIDE)('%s erreicht weder die Einstellungen noch den Export des Protokolls', (file) => {
    const source = readFileSync(file, 'utf8');
    for (const name of SESSION_ONLY) expect(source, `${file} nennt ${name}`).not.toContain(name);
  });
});
