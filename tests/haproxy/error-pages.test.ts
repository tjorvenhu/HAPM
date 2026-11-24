import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseErrorFiles,
  isManageableErrorFile,
  parseStatusLine,
  renderErrorFile,
  errorFiles,
  hasErrorPage,
  planErrorPages,
  writableErrorPages,
  parseFirstLines,
  parseDigests,
  errorPageFirstLinesCommand,
  errorPageDigestCommand,
  errorPageWriteCommand,
  errorPageRestoreCommand,
  errorPageBackups,
  ERROR_FILE_MAX_BYTES,
} from '@/lib/haproxy/error-pages';

/**
 * Die Fehlerseiten des Reverse-Proxys.
 *
 * Geschrieben werden Dateien, die HAProxy beim Laden einliest. Ist eine davon
 * kaputt, startet die Maschine nicht mehr, und zwar nicht heute, sondern beim
 * nächsten Neustart. Was diese Datei deshalb festhält:
 *
 *  - Der Status kommt aus der Datei und nicht aus der `errorfile`-Zeile.
 *  - Angefasst wird nur, was unter /etc/haproxy liegt.
 *  - Was auf der Maschine ankommt, ist Byte für Byte, was hier entsteht, samt
 *    CRLF, und das Original bleibt daneben liegen.
 *
 * Ob HAProxy eine so erzeugte Datei annimmt und ausliefert, prüft
 * `scripts/verify-proxy-pages.ts` gegen ein echtes HAProxy.
 */

const digestOf = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');

const CONFIG = `global
    log /dev/log local0

defaults
    mode http
    errorfile 400 /etc/haproxy/errors/400.http
    errorfile 403 /etc/haproxy/errors/403.http
    errorfile 503 /etc/haproxy/errors/503.http
    # errorfile 504 /etc/haproxy/errors/auskommentiert.http
    errorloc 502 https://example.org/fehler

frontend https_in
    bind :443 ssl crt /etc/haproxy/certs/
    default_backend default_404

backend default_404
    errorfile 503 /etc/haproxy/errors/404.http

http-errors eigene
    errorfile 500 /usr/share/haproxy/500.http
`;

describe('parseErrorFiles', () => {
  it('liest die Zeilen aus jedem Abschnitt', () => {
    expect(parseErrorFiles(CONFIG)).toEqual([
      { code: 400, path: '/etc/haproxy/errors/400.http' },
      { code: 403, path: '/etc/haproxy/errors/403.http' },
      { code: 503, path: '/etc/haproxy/errors/503.http' },
      { code: 503, path: '/etc/haproxy/errors/404.http' },
      { code: 500, path: '/usr/share/haproxy/500.http' },
    ]);
  });

  it('lässt Kommentare und Umleitungen aus', () => {
    const paths = parseErrorFiles(CONFIG).map((ref) => ref.path);
    expect(paths.join(' ')).not.toContain('auskommentiert');
    expect(paths.join(' ')).not.toContain('example.org');
  });
});

describe('isManageableErrorFile', () => {
  it('nimmt, was unter /etc/haproxy liegt', () => {
    expect(isManageableErrorFile('/etc/haproxy/errors/503.http')).toBe(true);
    expect(isManageableErrorFile('/etc/haproxy/seiten/fehler_503.http')).toBe(true);
  });

  it('fasst nichts außerhalb an', () => {
    // Der Pfad kommt aus `haproxy.cfg`, die jeder von Hand ändern darf, und geht
    // in ein Kommando, das als root schreibt.
    expect(isManageableErrorFile('/usr/share/haproxy/500.http')).toBe(false);
    expect(isManageableErrorFile('/etc/shadow')).toBe(false);
    expect(isManageableErrorFile('/etc/haproxy/../shadow')).toBe(false);
    expect(isManageableErrorFile('errors/503.http')).toBe(false);
    expect(isManageableErrorFile('/etc/haproxy/errors/')).toBe(false);
    expect(isManageableErrorFile('/etc/haproxy/errors/50 3.http')).toBe(false);
    expect(isManageableErrorFile("/etc/haproxy/errors/'503.http")).toBe(false);
    expect(isManageableErrorFile('/etc/haproxy/errors/$(id).http')).toBe(false);
  });

  it('fasst die Konfiguration und ihre Sicherungen nicht an', () => {
    expect(isManageableErrorFile('/etc/haproxy/haproxy.cfg')).toBe(false);
    expect(isManageableErrorFile('/etc/haproxy/haproxy.cfg.backup-20260101-120000')).toBe(false);
  });
});

describe('parseStatusLine', () => {
  it('liest den Status aus der ersten Zeile', () => {
    expect(parseStatusLine('HTTP/1.0 503 Service Unavailable')).toBe(503);
    expect(parseStatusLine('HTTP/1.1 404 Not Found\r')).toBe(404);
    expect(parseStatusLine('HTTP/1.1 200')).toBe(200);
  });

  it('rät nicht', () => {
    expect(parseStatusLine('<html>')).toBeNull();
    expect(parseStatusLine('')).toBeNull();
    expect(parseStatusLine('HTTP/2 503')).toBeNull();
  });
});

describe('renderErrorFile', () => {
  it('ist eine rohe HTTP-Antwort mit CRLF', () => {
    const file = renderErrorFile(503);
    const [head, body] = file.split('\r\n\r\n');
    expect(head.split('\r\n')).toEqual([
      'HTTP/1.1 503 Service Unavailable',
      'Cache-Control: no-cache',
      'Connection: close',
      'Content-Type: text/html; charset=utf-8',
    ]);
    expect(body.startsWith('<!doctype html>')).toBe(true);
    expect(body).toContain('>503<');
    // Der Rumpf selbst trägt kein CR: er ist eine Zeile mit einem Zeilenende.
    expect(body.includes('\r')).toBe(false);
  });

  it('behält den Status, den es bekommt', () => {
    for (const { status, content } of errorFiles()) {
      expect(parseStatusLine(content.split('\r\n')[0])).toBe(status);
    }
  });

  it('passt in HAProxys Puffer', () => {
    for (const { content } of errorFiles()) {
      expect(Buffer.byteLength(content, 'utf8')).toBeLessThan(ERROR_FILE_MAX_BYTES);
    }
  });

  it('sagt bei 404, dass die Adresse nicht eingerichtet ist', () => {
    // Auf dem Proxy meint eine 404 die ganze Domain. „Zur Startseite" führte
    // auf dieselbe Seite.
    const file = renderErrorFile(404);
    expect(file).toContain('Unter dieser Adresse ist nichts eingerichtet.');
    expect(file).not.toContain('Zur Startseite');
  });

  it('kennt die üblichen Fehler und wirft bei allem anderen', () => {
    for (const status of [400, 403, 404, 408, 429, 500, 502, 503, 504]) {
      expect(hasErrorPage(status)).toBe(true);
    }
    expect(hasErrorPage(200)).toBe(false);
    expect(() => renderErrorFile(200)).toThrow();
  });
});

describe('planErrorPages', () => {
  const refs = parseErrorFiles(CONFIG);
  const lines = new Map([
    ['/etc/haproxy/errors/400.http', 'HTTP/1.0 400 Bad request'],
    ['/etc/haproxy/errors/403.http', 'HTTP/1.1 403 Forbidden'],
    ['/etc/haproxy/errors/404.http', 'HTTP/1.0 404 Not Found'],
  ]);
  const digests = new Map([
    ['/etc/haproxy/errors/400.http', 'x'.repeat(64)],
    ['/etc/haproxy/errors/403.http', digestOf(renderErrorFile(403))],
    ['/etc/haproxy/errors/404.http', 'y'.repeat(64)],
  ]);
  const plan = planErrorPages(refs, lines, digests, digestOf);
  const entry = (path: string) => plan.find((e) => e.path === path)!;

  it('nimmt den Status aus der Datei, nicht aus der Zeile', () => {
    // `errorfile 503 …/404.http` im Backend für unbekannte Domains: nach der
    // Zahl in der Zeile geschrieben würde aus der 404 eine 503.
    const page = entry('/etc/haproxy/errors/404.http');
    expect(page.codes).toEqual([503]);
    expect(page.status).toBe(404);
    expect(page.state).toBe('other');
  });

  it('erkennt, was schon die aktuelle Seite trägt', () => {
    expect(entry('/etc/haproxy/errors/403.http').state).toBe('current');
    expect(entry('/etc/haproxy/errors/400.http').state).toBe('other');
  });

  it('deutet eine fehlende Datei nicht um', () => {
    // Für 503.http kam keine erste Zeile zurück. Das ist „nicht lesbar" und
    // nicht „dann eben der Code aus der Zeile".
    const page = entry('/etc/haproxy/errors/503.http');
    expect(page.status).toBeNull();
    expect(page.state).toBe('unreadable');
  });

  it('fasst fremde Pfade nicht an', () => {
    expect(entry('/usr/share/haproxy/500.http').state).toBe('foreign');
  });

  it('schreibt nur, was abweicht und lesbar ist', () => {
    expect(writableErrorPages(plan).map((e) => e.path)).toEqual([
      '/etc/haproxy/errors/400.http',
      '/etc/haproxy/errors/404.http',
    ]);
  });

  it('lässt einen Status ohne Vorlage stehen', () => {
    const odd = planErrorPages(
      [{ code: 200, path: '/etc/haproxy/errors/200.http' }],
      new Map([['/etc/haproxy/errors/200.http', 'HTTP/1.0 200 OK']]),
      new Map(),
      digestOf
    );
    expect(odd[0].state).toBe('unsupported');
    expect(writableErrorPages(odd)).toEqual([]);
  });

  it('führt eine Datei einmal, auch wenn zwei Zeilen sie nennen', () => {
    const twice = planErrorPages(
      [
        { code: 502, path: '/etc/haproxy/errors/5xx.http' },
        { code: 504, path: '/etc/haproxy/errors/5xx.http' },
      ],
      new Map([['/etc/haproxy/errors/5xx.http', 'HTTP/1.0 503 Service Unavailable']]),
      new Map(),
      digestOf
    );
    expect(twice).toHaveLength(1);
    expect(twice[0].codes).toEqual([502, 504]);
    expect(twice[0].status).toBe(503);
  });
});

describe('Die Kommandos, von einer echten Bash nachgerechnet', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  /* Relative Pfade und ein Arbeitsverzeichnis: unter Windows trüge ein voller
     Pfad einen Doppelpunkt (`C:/…`), und an dem trennt `parseFirstLines`. Auf
     der Maschine gibt es keinen, das stellt `isManageableErrorFile` sicher.
     Über stdin, weil eine Seite eine einzige Zeile von gut 8 KB ist (siehe
     lock-page.test.ts). */
  const bash = (command: string) =>
    execFileSync('bash', ['-s'], {
      input: command,
      encoding: 'utf8',
      cwd: dir!,
      // stderr nicht durchreichen: ein Test erwartet, dass `cp` scheitert.
      stdio: ['pipe', 'pipe', 'pipe'],
    });

  const OLD = 'HTTP/1.0 404 Not Found\r\nContent-Type: text/html\r\n\r\n<h1>alt</h1>\n';

  function setup(): string[] {
    dir = mkdtempSync(join(tmpdir(), 'hapm-errors-'));
    mkdirSync(join(dir, 'errors'));
    writeFileSync(join(dir, 'errors/404.http'), OLD);
    writeFileSync(join(dir, 'errors/503.http'), 'HTTP/1.0 503 Service Unavailable\r\n\r\nalt\n');
    return ['errors/404.http', 'errors/503.http', 'errors/fehlt.http'];
  }

  it('liest erste Zeile und Prüfsumme, und lässt Fehlendes aus', () => {
    const paths = setup();
    const lines = parseFirstLines(bash(errorPageFirstLinesCommand(paths)));
    expect(lines.get('errors/404.http')).toBe('HTTP/1.0 404 Not Found');
    expect(lines.get('errors/503.http')).toBe('HTTP/1.0 503 Service Unavailable');
    expect(lines.has('errors/fehlt.http')).toBe(false);

    const digests = parseDigests(bash(errorPageDigestCommand(paths)));
    expect(digests.get('errors/404.http')).toBe(digestOf(OLD));
    expect(digests.has('errors/fehlt.http')).toBe(false);
  });

  it('schreibt Byte für Byte, samt CRLF, und sichert vorher', () => {
    setup();
    const content = renderErrorFile(404);
    bash(errorPageWriteCommand('errors/404.http', content));

    // Der Wagenrücklauf überlebt den Weg. Ginge er verloren, stünde eine
    // Datei mit anderer Prüfsumme da, die bei jedem Blick als „andere Seite"
    // gälte, und HAProxy läse Kopfzeilen ohne CRLF.
    expect(readFileSync(join(dir!, 'errors/404.http'), 'utf8')).toBe(content);
    expect(parseDigests(bash(errorPageDigestCommand(['errors/404.http']))).get('errors/404.http')).toBe(
      digestOf(content)
    );

    const { previous, original } = errorPageBackups('errors/404.http');
    expect(readFileSync(join(dir!, previous), 'utf8')).toBe(OLD);
    expect(readFileSync(join(dir!, original), 'utf8')).toBe(OLD);
  });

  it('behält das Original über mehrere Läufe', () => {
    setup();
    const first = renderErrorFile(404);
    bash(errorPageWriteCommand('errors/404.http', first));
    // Ein zweiter Lauf, etwa nach einer neuen Fassung der Seiten.
    bash(errorPageWriteCommand('errors/404.http', renderErrorFile(503)));

    const { previous, original } = errorPageBackups('errors/404.http');
    // Die Seite von Hand bleibt die Seite von Hand …
    expect(readFileSync(join(dir!, original), 'utf8')).toBe(OLD);
    // … und zurückgestellt wird auf den Stand vor DIESEM Lauf.
    expect(readFileSync(join(dir!, previous), 'utf8')).toBe(first);
  });

  it('stellt den Stand vor dem Vorgang zurück', () => {
    setup();
    bash(errorPageWriteCommand('errors/404.http', renderErrorFile(404)));
    bash(errorPageRestoreCommand('errors/404.http'));
    expect(readFileSync(join(dir!, 'errors/404.http'), 'utf8')).toBe(OLD);
  });

  it('schreibt nichts, wenn die Datei fehlt', () => {
    setup();
    // Die Kette bricht am ersten `cp` ab. Eine Datei anzulegen, auf die keine
    // Zeile verweist, ist nicht die Aufgabe dieses Kommandos.
    expect(() => bash(errorPageWriteCommand('errors/fehlt.http', renderErrorFile(503)))).toThrow();
    expect(existsSync(join(dir!, 'errors/fehlt.http'))).toBe(false);
  });
});
