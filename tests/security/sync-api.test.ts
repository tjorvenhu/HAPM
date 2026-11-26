import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Die Routen des Abgleichs zwischen Knoten unter `/api/sync/**`.
 *
 * Eine davon (`node`) kommt ohne Sitzung und ohne API-Key aus und kann
 * trotzdem die Konfiguration des Proxys samt Zertifikaten ersetzen: ihr Zugang
 * ist der Kopplungsschlüssel. Diese Datei hält fest, dass sie die einzige ist,
 * dass vor ihrer Prüfung nichts gelesen wird, und dass die Prüfungen in der
 * Reihenfolge stehen, in der sie schützen. Das Verhalten selbst rechnet
 * `tests/sync/receive.test.ts` über echtes HTTP nach.
 *
 * Alle übrigen sind Routen der Oberfläche: Sitzung, bei jedem Schreiben vorher
 * der CSRF-Token, und der Kopplungsschlüssel verlässt den Server genau an
 * einer Stelle.
 */

const DIR = 'app/api/sync';
const NODE_ROUTE = join(DIR, 'node', 'route.ts').replace(/\\/g, '/');

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) routeFiles(path, out);
    else if (entry === 'route.ts') out.push(path.replace(/\\/g, '/'));
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
const SESSION_FILES = FILES.filter((file) => file !== NODE_ROUTE);
const CASES = SESSION_FILES.flatMap((file) => handlers(readFileSync(file, 'utf8')).map((handler) => ({ file, ...handler })));

describe('die Routen der Oberfläche', () => {
  it('findet alle Routen, damit ein kaputter Pfad die Suite nicht grün macht', () => {
    expect(FILES).toContain(NODE_ROUTE);
    expect(SESSION_FILES.sort()).toEqual(
      ['key', 'peers', 'peers/[id]', 'runs/[id]'].map((part) => `${DIR}/${part}/route.ts`).concat(`${DIR}/route.ts`).sort()
    );
    expect(CASES.map((c) => c.method).sort()).toEqual(['DELETE', 'GET', 'GET', 'PATCH', 'POST', 'POST', 'POST']);
  });

  it.each(CASES)('$file $method verlangt eine Sitzung', ({ body }) => {
    expect(body).toContain('await requireSession()');
    expect(body).toContain('handleError(err)');
  });

  it.each(CASES.filter((c) => c.method !== 'GET'))('$file $method prüft zuerst den CSRF-Token', ({ body }) => {
    const csrf = body.indexOf('await requireCsrf(request)');
    const session = body.indexOf('await requireSession()');
    expect(csrf, 'requireCsrf(request) fehlt').toBeGreaterThan(-1);
    expect(csrf).toBeLessThan(session);
    for (const marker of ['await jsonBody', 'await params', 'changeSyncRole(', 'createPairingKey(', 'addSyncPeer(', 'removeSyncPeer(', 'startSyncRun(']) {
      const at = body.indexOf(marker);
      if (at > -1) expect(session, `${marker} steht vor der Sitzung`).toBeLessThan(at);
    }
  });

  it.each(CASES.filter((c) => c.method !== 'GET'))('$file $method reicht den Benutzer ins Protokoll', ({ body }) => {
    expect(body).toContain('userEmail: session.email');
    expect(body).toContain('getClientIP(request)');
  });

  it('gibt den Kopplungsschlüssel an genau einer Stelle heraus', () => {
    const issuing = SESSION_FILES.filter((file) => readFileSync(file, 'utf8').includes('createPairingKey'));
    expect(issuing).toEqual([`${DIR}/key/route.ts`]);
    // Die Übersicht nennt nur, ob einer gesetzt ist.
    const actions = readFileSync('lib/sync/actions.ts', 'utf8');
    const overview = actions.slice(actions.indexOf('export async function syncOverview'), actions.indexOf('export type SyncOverview'));
    expect(overview).toContain('keySet');
    expect(overview).not.toContain('openKey');
    expect(overview).not.toMatch(/pairingKey:\s*settings\.pairingKey\b/);
    expect(actions).toContain('const { key: _key, ...rest } = peer;');
  });
});

describe('der Endpunkt für andere Knoten', () => {
  const route = readFileSync(NODE_ROUTE, 'utf8');
  const receive = readFileSync('lib/sync/receive.ts', 'utf8');
  const handler = receive.slice(receive.indexOf('export async function handleNodeRequest'));

  it('tut in der Route nichts außer zu übergeben', () => {
    // Keine Sitzung (ein Knoten hat keine) und nichts, was vor der Prüfung liest.
    expect(route).toContain('return await handleNodeRequest(request)');
    for (const marker of ['requireSession', 'requireServiceToken', 'request.json', 'request.arrayBuffer', 'request.text', 'jsonBody', 'getSyncSettings', '@/lib/db']) {
      expect(route, marker).not.toContain(marker);
    }
    expect(handlers(route).map((h) => h.method)).toEqual(['POST']);
  });

  it('prüft in der Reihenfolge, die schützt', () => {
    const order = [
      'recentFailures(ip) >= FAILED_ATTEMPTS_LIMIT', // Fehlversuche, bevor irgendetwas gelesen wird
      'parseHeader(', // Form der Kopfzeile
      'getSyncSettings()', // erst dann die Datenbank
      'verifyHeader(', // MAC und Zeit
      'header.length > LIMITS[header.kind]', // die Länge, bevor gelesen wird
      'nonces.claim(', // jede Anfrage einmal
      'await readBody(', // erst jetzt der Rumpf
      'openRequest(', // entschlüsseln und prüfen
      'acceptBundle(', // erst danach entscheidet die Rolle
    ];
    const positions = order.map((marker) => handler.indexOf(marker));
    for (const [index, at] of positions.entries()) expect(at, `${order[index]} fehlt`).toBeGreaterThan(-1);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('liest den Rumpf nur über die begrenzte Funktion', () => {
    expect(handler).not.toMatch(/request\.(arrayBuffer|text|json|formData|blob)\(/);
    expect(receive).toContain('if (size > limit)');
  });

  it('zählt jede Absage ohne gültigen Schlüssel als Fehlversuch', () => {
    // Vier Stellen: Kopfzeile unlesbar, kein Schlüssel gesetzt, falscher Schlüssel, Rumpf nicht zu öffnen.
    const denials = [...handler.matchAll(/noteFailure\(ip\);\s*throw denied\(\);/g)];
    expect(denials).toHaveLength(4);
  });

  it('verschlüsselt die Antwort und bindet sie an die Anfrage', () => {
    expect(handler).toContain('sealResponse(key, header.nonce,');
  });

  it('gehört nicht zum Baum der API-Keys', () => {
    // Dort verlangt `internal-api.test.ts` von jeder Route ein Service-Token.
    expect(NODE_ROUTE.startsWith('app/api/internal/')).toBe(false);
  });
});
