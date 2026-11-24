import { describe, it, expect } from 'vitest';
import {
  parseStatsSocket,
  parseStatsCsv,
  serviceHealth,
  type BackendServerState,
} from '@/lib/haproxy/config';

/**
 * Der Zustand der Ziele, aus HAProxys eigenem Healthcheck.
 *
 * Zwei Dinge sind daran wichtig, und beide sind Fragen der Ehrlichkeit:
 *
 *  - Der Socket-Pfad wird GELESEN und nicht geraten. `/run/haproxy/admin.sock`
 *    und `/var/run/haproxy.sock` sind beide üblich; wer rät, findet bei der
 *    Hälfte der Konfigurationen nichts und hielte das für „alles unten".
 *  - Ein Server ohne `check` ist unbekannt, nicht in Ordnung. HAProxy prüft ihn
 *    nicht, also weiß niemand etwas über ihn — und ein grüner Punkt darüber
 *    wäre die beruhigende Anzeige ohne Deckung.
 */

const CSV = `# pxname,svname,qcur,qmax,scur,status,weight,
website_intern,server1,0,0,0,UP,1,
website_intern,BACKEND,0,0,0,UP,1,
coolify,coolify_ui,0,0,0,UP,1,
coolify_terminal,coolify_term,0,0,0,DOWN,1,
altbestand,alt,0,0,0,no check,1,
https_in,FRONTEND,0,0,0,OPEN,,
`;

const STATES = parseStatsCsv(CSV);

/** Nur die Felder, die `serviceHealth` liest. */
function service(id: string, routes: string[] = []) {
  return { id, routes: routes.map((backend) => ({ backend })) } as Parameters<
    typeof serviceHealth
  >[0];
}

describe('parseStatsSocket', () => {
  it('findet den Unix-Socket samt Parametern dahinter', () => {
    expect(
      parseStatsSocket('global\n    stats socket /run/haproxy/admin.sock mode 660 level admin\n')
    ).toBe('/run/haproxy/admin.sock');
  });

  it('ignoriert einen Socket über TCP', () => {
    // Abgefragt wird der Socket als Datei im geteilten Verzeichnis, also nur ein Pfad.
    expect(parseStatsSocket('global\n    stats socket ipv4@127.0.0.1:9999 level admin\n')).toBeNull();
  });

  it('gibt null zurück, wenn es keinen gibt', () => {
    expect(parseStatsSocket('global\n    daemon\n')).toBeNull();
  });
});

describe('parseStatsCsv', () => {
  it('liest Backend, Server und Status über die Kopfzeile', () => {
    // Über die Spaltennummer wäre es falsch, sobald HAProxy eine Spalte
    // anhängt — und das tut es zwischen den Versionen.
    expect(STATES).toContainEqual({
      backend: 'coolify_terminal',
      server: 'coolify_term',
      status: 'DOWN',
    });
  });

  it('lässt die Sammelzeilen FRONTEND und BACKEND weg', () => {
    expect(STATES.every((s) => s.server !== 'BACKEND' && s.server !== 'FRONTEND')).toBe(true);
  });

  it('überlebt eine Ausgabe ohne Kopfzeile', () => {
    expect(parseStatsCsv('irgendwas\n')).toEqual([]);
    expect(parseStatsCsv('')).toEqual([]);
  });
});

describe('serviceHealth', () => {
  it('ist up, wenn alle Ziele antworten', () => {
    expect(serviceHealth(service('website_intern'), STATES)).toBe('up');
  });

  it('rechnet die Backends der Pfad-Regeln mit', () => {
    // Ein totes Terminal-Backend ist ein Teil des Dienstes, der nicht antwortet.
    expect(serviceHealth(service('coolify', ['coolify_terminal']), STATES)).toBe('partial');
    expect(serviceHealth(service('coolify'), STATES)).toBe('up');
  });

  it('ist down, wenn kein Ziel antwortet', () => {
    expect(serviceHealth(service('coolify_terminal'), STATES)).toBe('down');
  });

  it('ist unbekannt ohne Healthcheck und ohne Zahlen', () => {
    expect(serviceHealth(service('altbestand'), STATES)).toBe('unknown');
    expect(serviceHealth(service('website_intern'), [])).toBe('unknown');
    // Ein Eintrag, über den die Statistik gar nichts sagt.
    expect(serviceHealth(service('gibtsnicht'), STATES)).toBe('unknown');
  });

  it('nimmt UP mit Zusatz als up', () => {
    // HAProxy schreibt beim Hochlaufen „UP 2/3".
    const states: BackendServerState[] = [
      { backend: 'x', server: 'a', status: 'UP 2/3' },
    ];
    expect(serviceHealth(service('x'), states)).toBe('up');
  });
});
