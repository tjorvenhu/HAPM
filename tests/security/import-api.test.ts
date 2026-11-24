import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Die Routen des Imports unter `/api/haproxy/import/**`.
 *
 * Beide nehmen bis zu einem Megabyte Text an, und die eine startet einen Lauf,
 * der Zertifikate beantragt und HAProxy neu lädt. Diese Datei hält fest, dass
 * jede von ihnen zuerst den CSRF-Token und dann die Sitzung prüft, bevor sie
 * den Rumpf liest oder die Maschine fragt, und dass der Import im Protokoll
 * steht.
 */

const IMPORT_DIR = 'app/api/haproxy/import';

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) routeFiles(path, out);
    else if (entry === 'route.ts') out.push(path);
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

const FILES = routeFiles(IMPORT_DIR);
const CASES = FILES.flatMap((file) =>
  handlers(readFileSync(file, 'utf8')).map((handler) => ({ file, ...handler }))
);

describe('die Routen des Imports', () => {
  it('findet beide Routen, damit ein kaputter Pfad die Suite nicht grün macht', () => {
    expect(FILES).toHaveLength(2);
    expect(CASES.map((c) => c.method)).toEqual(['POST', 'POST']);
  });

  it.each(CASES)('$file $method prüft CSRF, dann die Sitzung, vor allem anderen', ({ body }) => {
    const csrf = body.indexOf('await requireCsrf(request)');
    const session = body.indexOf('await requireSession()');
    expect(csrf, 'requireCsrf(request) nicht gefunden').toBeGreaterThan(-1);
    expect(session, 'requireSession() nicht gefunden').toBeGreaterThan(csrf);
    for (const marker of ['await jsonBody', 'await probeProxy', 'await getProxyServer', 'parseImport(', 'await startHaproxyRun']) {
      const at = body.indexOf(marker);
      if (at > -1) expect(session, `${marker} steht vor der Prüfung der Sitzung`).toBeLessThan(at);
    }
  });

  it.each(CASES)('$file $method begrenzt die Größe, bevor der Rumpf gelesen wird', ({ body }) => {
    const limit = body.indexOf('IMPORT_MAX_BYTES');
    expect(limit).toBeGreaterThan(-1);
    expect(limit).toBeLessThan(body.indexOf('await jsonBody'));
    expect(body).toContain('importTextError(text)');
  });

  it('der Import liest den Text selbst und nimmt aus dem Browser nur Schlüssel', () => {
    const run = CASES.find((c) => c.file === join(IMPORT_DIR, 'route.ts'))!.body;
    // Mit oder ohne Übersetzer als zweites Argument: gelesen wird der Text selbst.
    expect(run).toMatch(/parseImport\(text[,)]/);
    expect(run).not.toMatch(/body\.(entries|service|stream|items)/);
    expect(run).toContain('logAudit(');
    expect(run).toContain('handleError(err)');
  });
});
