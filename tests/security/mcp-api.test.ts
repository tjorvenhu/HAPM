import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

/**
 * `/api/mcp` kommt wie `/api/internal/**` ohne Sitzung aus und schreibt
 * trotzdem an der Konfiguration des Proxys. Diese Datei hält fest, dass die
 * Route dieselbe Anmeldung benutzt und sie vor allem anderen prüft.
 */

const FILE = 'app/api/mcp/route.ts';
const source = readFileSync(FILE, 'utf8');
const post = source.slice(source.search(/export\s+async\s+function\s+POST\s*\(/));

describe('/api/mcp', () => {
  it('prüft im POST das Service-Token vor allem anderen', () => {
    const auth = post.indexOf('await requireServiceToken(request)');
    expect(auth, 'requireServiceToken(request) nicht gefunden').toBeGreaterThan(-1);
    for (const marker of ['createMcpServer(', 'handleRequest(', 'request.json', 'await jsonBody']) {
      const at = post.indexOf(marker);
      if (at > -1) expect(auth, `${marker} steht vor der Token-Prüfung`).toBeLessThan(at);
    }
  });

  it('reicht den Dienst als Actor weiter, damit Lauf und Audit den Namen des Tokens tragen', () => {
    expect(post).toContain('haproxyActor(serviceActor(service), request)');
  });

  it('benutzt keine Sitzung und kein zweites Token-System', () => {
    expect(source).not.toContain('requireSession');
    expect(source).toContain("import { requireServiceToken } from '@/lib/service-auth';");
  });

  it('hält keinen Zustand zwischen Anfragen', () => {
    expect(source).toContain('sessionIdGenerator: undefined');
  });
});
