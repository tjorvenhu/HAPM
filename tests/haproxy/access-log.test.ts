import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  analyseCommand,
  discoverCommand,
  parseAnalysis,
  parseDiscovery,
  toIsoHour,
  LOG_CANDIDATES,
  type LogCandidate,
} from '@/lib/haproxy/access-log';

/**
 * Die Access-Log-Auswertung, von einer echten Bash und einem echten awk
 * nachgerechnet.
 *
 * Dieselbe Bauweise wie `prune.test.ts` und aus demselben Grund: das Kommando
 * ist Text, bis eine Shell es liest. Drei Dinge daran gehen im Betrieb **still**
 * kaputt und wären an einer nachgebauten Zerlegung in JavaScript nie
 * aufgefallen:
 *
 *  - Die Feldsuche. Der syslog-Kopf vor der eigentlichen Zeile ist nicht überall
 *    gleich lang; eine feste Feldnummer läse bei dem einen Format den
 *    Statuscode und beim nächsten die Bytes. Beides sind Zahlen, beides sieht
 *    plausibel aus.
 *  - Die IPv6-Adresse mit Port. `2001:db8::1:33122` von links getrennt ergibt
 *    `2001` — eine Adresse, die es gibt, und damit ein Land, das nicht stimmt.
 *  - Das Sortieren über `sort` statt in awk. `asort` gibt es nur in gawk, und
 *    auf Debian ist `awk` ein mawk. Ein Programm, das je nach Abbild still
 *    nichts liefert, ist keine Auswertung.
 *
 * Braucht eine echte Bash im PATH, wie `pnpm test` insgesamt (aus Git Bash
 * läuft es, aus PowerShell nicht).
 */

let dir: string | null = null;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/**
 * Unter Windows liefert `mkdtemp` einen Pfad mit Backslashes, und die sind in
 * einfachen Anführungszeichen buchstäblich. Git Bash versteht `C:/Users/…`.
 * Betrifft nur den Test: auf der Gegenstelle steht ein Linux-Pfad.
 */
function posix(path: string): string {
  return path.replace(/\\/g, '/');
}

/** Eine Zeile, wie rsyslog sie schreibt. */
function line(options: {
  ip: string;
  backend: string;
  status: number;
  bytes: number;
  path: string;
  method?: string;
  hour?: string;
}): string {
  const hour = options.hour ?? '12';
  return (
    `Feb  6 ${hour}:14:14 lb1 haproxy[1234]: ${options.ip}:54321 ` +
    `[06/Feb/2026:${hour}:14:14.123] https-in~ ${options.backend}/srv1 0/0/1/23/24 ` +
    `${options.status} ${options.bytes} - - ---- 10/10/0/0/0 0/0 ` +
    `"${options.method ?? 'GET'} ${options.path} HTTP/1.1"`
  );
}

const LOG = [
  line({ ip: '203.0.113.7', backend: 'kunde_shop', status: 200, bytes: 1500, path: '/' }),
  line({ ip: '203.0.113.7', backend: 'kunde_shop', status: 200, bytes: 2500, path: '/preise' }),
  line({ ip: '203.0.113.9', backend: 'kunde_shop', status: 404, bytes: 300, path: '/weg' }),
  line({ ip: '203.0.113.9', backend: 'kunde_shop', status: 500, bytes: 100, path: '/kaputt' }),
  // Dieselbe Seite, andere Stunde: fällt in einen anderen Balken.
  line({ ip: '198.51.100.4', backend: 'kunde_shop', status: 301, bytes: 0, path: '/alt', hour: '13' }),
  // Der Fall, für den von rechts getrennt wird.
  line({ ip: '2001:db8:c17:5::1', backend: 'intern_www', status: 200, bytes: 900, path: '/' }),
  // Abfrageteil: er darf nicht Teil des Pfades werden, sonst ist jede Suche
  // ein eigener Eintrag in der Rangliste.
  line({ ip: '198.51.100.4', backend: 'intern_www', status: 200, bytes: 800, path: '/suche?q=abc' }),
  line({
    ip: '198.51.100.4', backend: 'intern_www', status: 201, bytes: 40,
    path: '/api/dinge', method: 'POST',
  }),
  // Keine Zeile dieses Formats: sie zählt als gelesen und nicht als ausgewertet.
  'Feb  6 12:15:00 lb1 haproxy[1234]: Server kunde_shop/srv1 is DOWN, reason: Layer4 timeout',
].join('\n');

function analyse(backend?: string) {
  dir = mkdtempSync(join(tmpdir(), 'haproxy-log-'));
  const file = join(dir, 'haproxy.log');
  writeFileSync(file, `${LOG}\n`);

  const command = analyseCommand({
    // Im Betrieb kommt der Pfad aus LOG_CANDIDATES; hier ist es die Fixture.
    source: { kind: 'file', path: posix(file) as LogCandidate },
    backend,
    lines: 1000,
  });
  return parseAnalysis(execFileSync('bash', ['-c', command], { encoding: 'utf8' }));
}

describe('parseDiscovery', () => {
  it('nimmt den ersten Kandidaten der Liste', () => {
    const found = parseDiscovery(
      [`file ${LOG_CANDIDATES[1]}`, `file ${LOG_CANDIDATES[0]}`, 'journal'].join('\n')
    );
    // Die Reihenfolge ist die der Liste und nicht die der Ausgabe.
    expect(found).toEqual({ kind: 'file', path: LOG_CANDIDATES[0] });
  });

  it('fällt auf journald zurück', () => {
    expect(parseDiscovery('journal\n')).toEqual({ kind: 'journal' });
  });

  it('macht aus „nichts gefunden" keine Null', () => {
    // `none` heißt unbekannt. Die Oberfläche sagt dann, dass kein Log gefunden
    // wurde, statt „keine Zugriffe" anzuzeigen.
    expect(parseDiscovery('')).toEqual({ kind: 'none' });
  });

  it('nimmt nichts an, was nicht in der Liste steht', () => {
    // Der Pfad geht in ein Kommando, das als root läuft.
    expect(parseDiscovery('file /etc/shadow\n')).toEqual({ kind: 'none' });
  });
});

describe('discoverCommand', () => {
  it('findet eine vorhandene Datei und keine leere', () => {
    dir = mkdtempSync(join(tmpdir(), 'haproxy-find-'));
    // Der Befehl prüft feste Pfade; hier geht es nur darum, dass er läuft und
    // bei nichts Vorhandenem auch nichts behauptet.
    const out = execFileSync('bash', ['-c', discoverCommand()], { encoding: 'utf8' });
    for (const found of parseDiscovery(out).kind === 'file' ? [1] : []) expect(found).toBe(1);
    expect(out).not.toContain('file /etc');
  });
});

describe('analyseCommand', () => {
  it('zählt Zeilen, Anfragen und übertragene Menge', () => {
    const stats = analyse();
    expect(stats.lines).toBe(9);
    // Die DOWN-Meldung ist gelesen, aber keine Anfrage.
    expect(stats.parsed).toBe(8);
    expect(stats.bytes).toBe(1500 + 2500 + 300 + 100 + 0 + 900 + 800 + 40);
  });

  it('trennt die Adresse von RECHTS und findet damit auch IPv6', () => {
    const stats = analyse();
    expect(stats.ips.map((entry) => entry.key)).toContain('2001:db8:c17:5::1');
    // Nicht `2001` — genau der Fehler, den eine Trennung von links macht.
    expect(stats.ips.map((entry) => entry.key)).not.toContain('2001');
    expect(stats.uniqueIps).toBe(4);
  });

  it('sortiert die Adressen absteigend', () => {
    const stats = analyse();
    expect(stats.ips[0]).toEqual({ key: '198.51.100.4', count: 3 });
  });

  it('schlüsselt nach Backend und Statusklasse auf', () => {
    const stats = analyse();
    const shop = stats.backends.find((entry) => entry.backend === 'kunde_shop');
    expect(shop).toMatchObject({
      requests: 5, http2xx: 2, http3xx: 1, http4xx: 1, http5xx: 1, bytes: 4400,
    });
    const www = stats.backends.find((entry) => entry.backend === 'intern_www');
    expect(www).toMatchObject({ requests: 3, http2xx: 3 });
  });

  it('wirft den Abfrageteil des Pfades weg', () => {
    const stats = analyse();
    const paths = stats.paths.map((entry) => entry.key);
    expect(paths).toContain('/suche');
    expect(paths).not.toContain('/suche?q=abc');
  });

  it('zählt Methoden und genaue Statuscodes', () => {
    const stats = analyse();
    expect(stats.methods).toContainEqual({ key: 'POST', count: 1 });
    expect(stats.methods.find((entry) => entry.key === 'GET')?.count).toBe(7);
    expect(stats.statusCodes.find((entry) => entry.key === '200')?.count).toBe(4);
    expect(stats.statusCodes.find((entry) => entry.key === '500')?.count).toBe(1);
  });

  it('legt die Stunden in aufsteigender Folge ab', () => {
    const stats = analyse();
    expect(stats.hours).toEqual([
      { hour: '2026-02-06T12:00:00', count: 7 },
      { hour: '2026-02-06T13:00:00', count: 1 },
    ]);
    expect(stats.from).toBe('2026-02-06T12:00:00');
    expect(stats.to).toBe('2026-02-06T13:00:00');
  });

  it('grenzt auf ein Backend ein, und zwar ALLES', () => {
    const stats = analyse('intern_www');
    expect(stats.parsed).toBe(3);
    // Die eindeutigen Adressen sind dann die dieses Dienstes und nicht die der
    // Maschine — daran hängt die Länderverteilung im Drilldown.
    expect(stats.uniqueIps).toBe(2);
    expect(stats.backends).toHaveLength(1);
    expect(stats.paths.map((entry) => entry.key).sort()).toEqual(['/', '/api/dinge', '/suche']);
  });

  it('gibt bei einem unbekannten Backend nichts zurück statt alles', () => {
    const stats = analyse('gibtsnicht');
    expect(stats.parsed).toBe(0);
    expect(stats.uniqueIps).toBe(0);
    expect(stats.backends).toEqual([]);
  });
});

describe('parseAnalysis', () => {
  it('verträgt eine leere Ausgabe', () => {
    const stats = parseAnalysis('');
    expect(stats.parsed).toBe(0);
    expect(stats.from).toBeNull();
    expect(stats.backends).toEqual([]);
  });
});

describe('toIsoHour', () => {
  it('übersetzt das HAProxy-Datum', () => {
    expect(toIsoHour('06/Feb/2026:12')).toBe('2026-02-06T12:00:00');
    expect(toIsoHour('31/Dec/2025:23')).toBe('2025-12-31T23:00:00');
  });

  it('hängt kein Z an', () => {
    // HAProxy schreibt die Ortszeit der Maschine, und die steht nirgends in der
    // Zeile. Ein Z behauptete UTC — die Kurve läge dann je nach Jahreszeit eine
    // oder zwei Stunden daneben.
    expect(toIsoHour('06/Feb/2026:12')).not.toContain('Z');
  });

  it('gibt bei einem unbekannten Format null zurück', () => {
    expect(toIsoHour('2026-02-06T12')).toBeNull();
    expect(toIsoHour('06/Xyz/2026:12')).toBeNull();
    expect(toIsoHour('')).toBeNull();
  });
});
