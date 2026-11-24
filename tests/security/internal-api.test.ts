import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import {
  generateServiceToken,
  hashServiceToken,
  tokenPrefix,
  extractToken,
} from '@/lib/service-auth';

/**
 * `/api/internal/**` kommt ohne Sitzung aus und schreibt trotzdem an der
 * Konfiguration des Proxys. Der Baum bringt dafür seine eigene
 * Authentifizierung mit (ein Token je Dienst); diese Datei hält fest, dass er
 * sie auch wirklich hat.
 */

const INTERNAL_DIR = 'app/api/internal';

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) routeFiles(path, out);
    else if (entry === 'route.ts') out.push(path);
  }
  return out;
}

/** Die Handler, bei denen ein Aufruf etwas hinterlässt. */
const WRITE_HANDLER = /export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)\s*\(/;

function writes(file: string): boolean {
  return WRITE_HANDLER.test(readFileSync(file, 'utf8'));
}

describe('jede interne Route prüft das Token', () => {
  const files = routeFiles(INTERNAL_DIR);

  it('findet überhaupt Routen, damit ein kaputter Pfad die Suite nicht grün macht', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s ruft requireServiceToken', (file) => {
    const source = readFileSync(file, 'utf8');
    expect(source).toContain('requireServiceToken');
  });

  it.each(files)('%s prüft das Token vor allem anderen', (file) => {
    // Reihenfolge zählt: eine Route, die erst den Rumpf liest oder gar die
    // Datenbank fragt und dann das Token prüft, arbeitet für einen Fremden.
    // Verglichen werden Aufrufstellen, nicht Importe — die stehen immer oben.
    const source = readFileSync(file, 'utf8');
    const auth = source.indexOf('await requireServiceToken(request)');
    expect(auth, 'requireServiceToken(request) nicht gefunden').toBeGreaterThan(-1);

    for (const marker of [
      'await jsonBody',
      'await listAll',
      'await getServer',
      'await getDocument',
      // Die Auflöser des Reverse-Proxy-Baums. Sie fragen die Datenbank und
      // gehen anschließend per SSH auf eine Maschine — ohne sie in dieser Liste
      // prüfte der Test nur noch die Routen, die `listAll` selbst schreiben.
      'await resolveProxy',
      'await proxyServers',
      'await probeProxy',
      'await readGlobalSettings',
    ]) {
      const at = source.indexOf(marker);
      if (at > -1) expect(auth, `${marker} steht vor der Token-Prüfung`).toBeLessThan(at);
    }
  });

  /**
   * Die Audit-Pflicht gilt den SCHREIBENDEN Handlern.
   *
   * Nicht jeder Route: der Reverse-Proxy-Baum hat Endpunkte, die nichts
   * Geheimes liefern und im Sekundentakt abgefragt werden — ein Aufrufer, der
   * einen Lauf pollt, schriebe neunzig Zeilen je Vorgang. Ein Protokoll, in dem
   * die Vorgänge zwischen ihren eigenen Abfragen untergehen, beantwortet die
   * Frage nicht mehr, für die es da ist.
   *
   * Was der Test weiterhin für JEDE Datei verlangt, ist unverändert: Token,
   * Reihenfolge, keine Sitzung. Ein lesender Endpunkt, der später Geheimnisse
   * ausliefert, ist damit nicht abgedeckt — dafür gibt es keine Regel, die eine
   * Datei lesen kann, sondern nur den Blick beim Schreiben.
   */
  const writing = files.filter(writes);

  it('findet schreibende Routen, damit die Erkennung nicht still leerläuft', () => {
    expect(writing.length).toBeGreaterThan(0);
  });

  it.each(writing)('%s schreibt einen Audit-Eintrag mit dem Dienst', (file) => {
    const source = readFileSync(file, 'utf8');
    expect(source).toContain('serviceActor');
  });

  it.each(files)('%s benutzt nicht requireSession', (file) => {
    // Ein Dienst hat keine Anmeldung. Stünde beides da, wäre der Endpunkt für
    // den vorgesehenen Aufrufer unbenutzbar — und das fiele erst im Betrieb auf.
    const source = readFileSync(file, 'utf8');
    expect(source).not.toContain('requireSession');
  });

  /**
   * Der Bereich muss zum Verzeichnis passen.
   *
   * Ein Token nennt seit `lib/service-areas.ts` die Teilbäume, die es erreichen
   * darf — und das ist nur so viel wert, wie die Routen die Wahrheit über ihren
   * eigenen Standort sagen. Eine Datei unter `postgres/`, die sich als
   * `'haproxy'` ausgibt, wäre der Weg, auf dem ein Reverse-Proxy-Schlüssel an
   * die Verbindungsstrings der Kundendatenbanken kommt. Das ist keine Sorte
   * Fehler, die man beim Lesen bemerkt: der Aufruf sieht an jeder Stelle
   * richtig aus, nur eben nicht an dieser.
   *
   * Abgeleitet wird der Erwartungswert aus dem Pfad und nicht aus einer Liste
   * daneben — eine Liste müsste bei jeder neuen Route gepflegt werden, und
   * genau das vergisst man.
   */
});

describe('Token', () => {
  it('trägt ein erkennbares Präfix', () => {
    // Secret-Scanner in Git-Hosts und CI erkennen Token an ihrer Form. Ein
    // Token ohne Form fällt beim versehentlichen Commit niemandem auf.
    expect(generateServiceToken()).toMatch(/^hapm_[A-Za-z0-9_-]{40,}$/);
  });

  it('ist bei jedem Aufruf ein anderes', () => {
    const tokens = new Set(Array.from({ length: 500 }, generateServiceToken));
    expect(tokens.size).toBe(500);
  });

  it('wird als SHA-256-Hex gespeichert', () => {
    const token = generateServiceToken();
    expect(hashServiceToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashServiceToken(token)).toBe(hashServiceToken(token));
    expect(hashServiceToken(token)).not.toBe(hashServiceToken(generateServiceToken()));
  });

  it('gibt als Präfix zu wenig preis, um es zu erraten', () => {
    const token = generateServiceToken();
    const prefix = tokenPrefix(token);
    expect(token.startsWith(prefix)).toBe(true);
    // 12 Zeichen, davon 4 das feste `hapm_` — acht Zeichen Rest bei 43 Zeichen
    // Zufall reichen zum Wiedererkennen und nicht zum Rekonstruieren.
    expect(prefix).toHaveLength(12);
    expect(prefix.length).toBeLessThan(token.length / 2);
  });
});

describe('extractToken', () => {
  function req(headers: Record<string, string>): Request {
    return new Request('https://example.test/api/internal/x', { headers });
  }

  it('liest den Authorization-Header', () => {
    expect(extractToken(req({ authorization: 'Bearer hapm_abc' }))).toBe('hapm_abc');
  });

  it('nimmt Bearer unabhängig von der Schreibweise', () => {
    expect(extractToken(req({ authorization: 'bearer hapm_abc' }))).toBe('hapm_abc');
  });

  it('liest ersatzweise X-Service-Token', () => {
    // Manche Proxys räumen den Authorization-Header ab oder beanspruchen ihn.
    expect(extractToken(req({ 'x-service-token': 'hapm_abc' }))).toBe('hapm_abc');
  });

  it('ist null ohne Header und bei leerem Bearer', () => {
    expect(extractToken(req({}))).toBeNull();
    expect(extractToken(req({ authorization: 'Bearer   ' }))).toBeNull();
    expect(extractToken(req({ authorization: 'Basic dXNlcjpwdw==' }))).toBeNull();
  });
});
