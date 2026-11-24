import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Die Routen der Einrichtung unter `/api/setup/**`.
 *
 * Nur das Anlegen des ersten Kontos (`POST /api/setup`) kommt ohne Sitzung aus,
 * und nur, solange es kein Konto gibt. Alles darunter schreibt an
 * Einstellungen, DNS-Zugangsdaten und HAProxy und ist ein angemeldeter Aufruf.
 * Diese Datei hält fest, dass keine der Routen das vergisst.
 */

const SETUP_DIR = 'app/api/setup';

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) routeFiles(path, out);
    else if (entry === 'route.ts') out.push(path);
  }
  return out;
}

/** Die Routen der Schritte, ohne die des ersten Kontos. */
const STEP_ROUTES = routeFiles(SETUP_DIR).filter((file) => file !== join(SETUP_DIR, 'route.ts'));

/** Der Rumpf eines Handlers: von seiner Kopfzeile bis zum nächsten Export. */
function handlers(source: string): { method: string; body: string }[] {
  const starts = [...source.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/g)];
  return starts.map((match, index) => ({
    method: match[1],
    body: source.slice(match.index, starts[index + 1]?.index ?? source.length),
  }));
}

describe('jede Route der Einrichtung verlangt eine Anmeldung', () => {
  it('findet die Routen, damit ein kaputter Pfad die Suite nicht grün macht', () => {
    expect(STEP_ROUTES.length).toBeGreaterThanOrEqual(5);
  });

  const cases = STEP_ROUTES.flatMap((file) =>
    handlers(readFileSync(file, 'utf8')).map((handler) => ({ file, ...handler }))
  );

  it.each(cases)('$file $method prüft die Sitzung', ({ body }) => {
    expect(body).toContain('await requireSession()');
  });

  it.each(cases.filter((handler) => handler.method !== 'GET'))(
    '$file $method prüft den CSRF-Token vor allem anderen',
    ({ body }) => {
      const csrf = body.indexOf('await requireCsrf(request)');
      expect(csrf, 'requireCsrf(request) nicht gefunden').toBeGreaterThan(-1);
      for (const marker of ['await requireSession()', 'await jsonBody', 'await getSetupState', 'await updateSettings']) {
        const at = body.indexOf(marker);
        if (at > -1) expect(csrf, `${marker} steht vor der CSRF-Prüfung`).toBeLessThan(at);
      }
    }
  );

  it.each(cases.filter((handler) => handler.method !== 'GET'))(
    '$file $method schreibt einen Audit-Eintrag',
    ({ body }) => {
      expect(body).toMatch(/logAudit|audit\(/);
    }
  );
});

describe('GET /api/setup', () => {
  const source = readFileSync(join(SETUP_DIR, 'route.ts'), 'utf8');
  const get = handlers(source).find((handler) => handler.method === 'GET')!.body;

  it('gibt den Stand des Assistenten erst nach der Prüfung der Sitzung heraus', () => {
    const session = get.indexOf('await getSession()');
    const view = get.indexOf('readSetupView()');
    expect(session).toBeGreaterThan(-1);
    expect(view).toBeGreaterThan(session);
    // Dazwischen steht der Ausstieg für Unangemeldete.
    expect(get.slice(session, view)).toContain('return ok({ needsSetup })');
  });
});
