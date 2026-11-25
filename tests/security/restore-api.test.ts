import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Die Routen des Zurückspielens unter `/api/backup/restore/**`.
 *
 * Eine nimmt bis zu 512 MB entgegen, eine startet einen Helfer mit dem
 * Docker-Socket, der Konten, Schlüssel und Konfiguration ersetzt. Diese Datei
 * hält fest: jede schreibende Route prüft zuerst den CSRF-Token und dann die
 * Sitzung, bevor sie den Rumpf liest oder etwas anfasst; der Start verlangt
 * das Passwort, bevor irgendetwas vorbereitet wird; der Upload prüft die
 * Obergrenze, bevor er liest; und alles steht im Protokoll.
 */

const DIR = 'app/api/backup/restore';

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

const FILES = routeFiles(DIR);
const CASES = FILES.flatMap((file) => handlers(readFileSync(file, 'utf8')).map((handler) => ({ file, ...handler })));
const WRITING = CASES.filter((c) => c.method !== 'GET');

const TOUCHES = [
  'await jsonBody',
  'request.body',
  'stageUpload(',
  'stageFromFolder(',
  'prepareRestore(',
  'beginRestore(',
  'discardStaged(',
  'verifyPassword(',
];

describe('die Routen des Zurückspielens', () => {
  it('findet alle Routen, damit ein kaputter Pfad die Suite nicht grün macht', () => {
    // Fünf seit `runs/[id]`: der Stand eines Laufs für das Fenster, nur lesend.
    expect(FILES).toHaveLength(5);
    expect(CASES.map((c) => c.method).sort()).toEqual(['DELETE', 'GET', 'GET', 'POST', 'POST', 'POST']);
  });

  it.each(CASES)('$file $method verlangt eine Sitzung', ({ body }) => {
    expect(body).toContain('await requireSession()');
    expect(body).toContain('handleError(err)');
  });

  it.each(WRITING)('$file $method prüft CSRF, dann die Sitzung, vor allem anderen', ({ body }) => {
    const csrf = body.indexOf('await requireCsrf(request)');
    const session = body.indexOf('await requireSession()');
    expect(csrf, 'requireCsrf(request) nicht gefunden').toBeGreaterThan(-1);
    expect(session, 'requireSession() nicht gefunden').toBeGreaterThan(csrf);
    for (const marker of TOUCHES) {
      const at = body.indexOf(marker);
      if (at > -1) expect(session, `${marker} steht vor der Prüfung der Sitzung`).toBeLessThan(at);
    }
  });

  it.each(WRITING)('$file $method steht im Protokoll', ({ body }) => {
    expect(body).toContain('logAudit(');
  });

  it('der Start prüft das Passwort mit Sperre, bevor er etwas vorbereitet', () => {
    const start = WRITING.find((c) => c.file === join(DIR, 'start', 'route.ts'))!.body;
    const limit = start.indexOf('rateLimit(');
    const password = start.indexOf('verifyPassword(');
    const prepare = start.indexOf('prepareRestore(');
    const audit = start.indexOf('logAudit(');
    const begin = start.indexOf('beginRestore(');
    expect(limit).toBeGreaterThan(-1);
    expect(limit).toBeLessThan(password);
    expect(password).toBeLessThan(prepare);
    // Der Eintrag vor dem Start: so steht er auch in der Sicherung von unmittelbar vorher.
    expect(prepare).toBeLessThan(audit);
    expect(audit).toBeLessThan(begin);
  });

  it('der Upload prüft die Obergrenze, bevor er den Rumpf liest', () => {
    const upload = WRITING.find((c) => c.file === join(DIR, 'upload', 'route.ts'))!.body;
    expect(upload.indexOf('RESTORE_MAX_BYTES')).toBeGreaterThan(-1);
    expect(upload.indexOf('RESTORE_MAX_BYTES')).toBeLessThan(upload.indexOf('stageUpload('));
  });
});
