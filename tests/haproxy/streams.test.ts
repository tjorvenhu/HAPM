import { describe, it, expect } from 'vitest';
import {
  parseStreams,
  addStream,
  removeStream,
  replaceStream,
  renderStreamBlock,
  toStreamInput,
  readStreamInput,
  validateStreamInput,
  parseBindPorts,
  parseListeningPorts,
  bindConflict,
  matchesStreamSearch,
  type CreateStreamInput,
} from '@/lib/haproxy/streams';
import { addService, parseHaproxyConfig, HaproxyConfigError } from '@/lib/haproxy/config';

/**
 * Eine TCP-Weiterleitung ist ein `listen`-Abschnitt im BACKENDS-Teil einer
 * Gruppe. Diese Datei rechnet nach, was HAPM daran ändert.
 *
 * Das Fixture hat die Form einer gewachsenen Datei: ein Frontend mit
 * seinen `bind`-Zeilen, zwei Marker-Blöcke, ein Dienst-Backend daneben und ein
 * von Hand gepflegter `listen`-Abschnitt außerhalb aller Marker.
 */

const CONFIG = `global
    log /dev/log local0

defaults
    mode http
    option httplog
    timeout connect 5s

# ============================================================
frontend https_in
    bind :443 ssl crt /etc/haproxy/certs/
    bind :::443 v4v6 ssl crt /etc/haproxy/certs/

    # AUTO: nextcloud_intern
    acl host_nextcloud_intern hdr(host),lower -i cloud.example.org
    use_backend nextcloud_intern if host_nextcloud_intern

# END AUTO INTERN SERVICES

# END AUTO KUNDEN SERVICES

    default_backend nichts

# ============================================================

# AUTO: nextcloud_intern
backend nextcloud_intern
    server intern-nextcloud 10.10.0.3:80 check

# AUTO: pg_intern
listen pg_intern
    mode tcp
    option tcplog
    bind :5432
    tcp-request connection reject if !{ src 10.0.0.0/8 203.0.113.7 }
    balance leastconn

    server db1 10.10.0.50:5432 check
    server db2 10.10.0.51:5432 check

# END AUTO INTERN BACKENDS

# END AUTO KUNDEN BACKENDS

listen von_hand
    mode tcp
    bind :2222
    server jump 10.10.0.9:22

backend nichts
    http-request deny deny_status 404
`;

const INPUT: CreateStreamInput = {
  scope: 'KUNDEN',
  id: 'redis_kunde',
  port: 6379,
  servers: [{ name: 'redis', target: '10.10.0.60:6379', weight: null }],
  balance: null,
  check: true,
  allowedSources: ['10.0.0.0/8'],
};

describe('parseStreams', () => {
  const streams = parseStreams(CONFIG);

  it('findet jeden listen-Abschnitt, auch den außerhalb der Marker', () => {
    expect(streams.map((s) => s.id)).toEqual(['pg_intern', 'von_hand']);
  });

  it('ordnet die Gruppe über den nächsten BACKENDS-Endmarker zu', () => {
    expect(streams[0].scope).toBe('INTERN');
    // Steht hinter beiden Markern: von Hand gepflegt, gehört keiner Gruppe.
    expect(streams[1].scope).toBeNull();
  });

  it('liest Port, Verfahren, Absenderliste und Ziele', () => {
    const pg = streams[0];
    expect(pg.port).toBe(5432);
    expect(pg.balance).toBe('leastconn');
    expect(pg.allowedSources).toEqual(['10.0.0.0/8', '203.0.113.7']);
    expect(pg.servers.map((s) => s.target)).toEqual(['10.10.0.50:5432', '10.10.0.51:5432']);
    expect(pg.check).toBe(true);
    expect(pg.auto).toBe(true);
    expect(pg.extras).toEqual([]);
    expect(pg.editable).toBe(true);
  });

  it('macht einen Abschnitt ohne option tcplog nur lesbar', () => {
    // Der von Hand gepflegte trägt weder tcplog noch einen AUTO-Kommentar.
    const hand = streams[1];
    expect(hand.extras).toContain('ohne option tcplog');
    expect(hand.editable).toBe(false);
    // Und außerhalb der Marker ist er auch nicht löschbar: sein Anfang wäre
    // „hinter dem Abschnitt davor", und das ist geraten.
    expect(hand.removable).toBe(false);
  });

  it('nimmt einen listen-Abschnitt in mode http nicht als TCP-Weiterleitung', () => {
    const http = parseStreams(CONFIG.replace('    mode tcp\n    option tcplog', '    mode http\n    option tcplog'));
    expect(http[0].extras).toContain('mode http');
    expect(http[0].editable).toBe(false);
    // Angezeigt wird er trotzdem — ein Abschnitt, der nirgends auftaucht, ist
    // der Grund, aus dem später ein Port doppelt vergeben wird.
    expect(http[0].id).toBe('pg_intern');
  });

  it('macht eine bind-Zeile mit Parametern nur lesbar statt sie zu deuten', () => {
    const ssl = parseStreams(CONFIG.replace('    bind :5432\n', '    bind 10.0.0.1:5432 ssl\n'));
    expect(ssl[0].port).toBeNull();
    expect(ssl[0].editable).toBe(false);
  });

  it('zählt Zusätze auf der server-Zeile als unbekannt', () => {
    const mit = parseStreams(
      CONFIG.replace('    server db1 10.10.0.50:5432 check', '    server db1 10.10.0.50:5432 check inter 2s')
    );
    expect(mit[0].editable).toBe(false);
    // Gelesen wird die Zeile trotzdem: die Karte soll das Ziel zeigen.
    expect(mit[0].servers[0].target).toBe('10.10.0.50:5432');
  });

  it('meldet gemischtes check statt es zu vereinheitlichen', () => {
    const mixed = parseStreams(
      CONFIG.replace('    server db2 10.10.0.51:5432 check', '    server db2 10.10.0.51:5432')
    );
    expect(mixed[0].extras).toContain('server-Zeilen mit unterschiedlichem check');
    expect(mixed[0].editable).toBe(false);
  });

  it('lässt die Dienste unberührt', () => {
    // Ein listen-Abschnitt zwischen den Backends darf den Dienst-Parser weder
    // verwirren noch selbst als Dienst auftauchen.
    expect(parseHaproxyConfig(CONFIG).map((s) => s.id)).toEqual(['nextcloud_intern']);
  });
});

describe('parseBindPorts', () => {
  it('findet jede gebundene Adresse mit ihrem Abschnitt', () => {
    const ports = parseBindPorts(CONFIG);
    expect(ports).toContainEqual({ port: 443, section: 'frontend https_in' });
    expect(ports).toContainEqual({ port: 5432, section: 'listen pg_intern' });
    expect(ports).toContainEqual({ port: 2222, section: 'listen von_hand' });
  });

  it('liest den Port hinter dem LETZTEN Doppelpunkt', () => {
    // `bind :::443` ist IPv6-Kurzschreibweise, kein Port „::443".
    expect(parseBindPorts('frontend f\n    bind :::8443')).toEqual([
      { port: 8443, section: 'frontend f' },
    ]);
  });

  it('trennt mehrere Adressen einer Zeile am Komma', () => {
    expect(parseBindPorts('listen l\n    bind :80,:8080').map((b) => b.port)).toEqual([80, 8080]);
  });
});

describe('parseListeningPorts', () => {
  /** Wie `ss -Hltn` es ausgibt: Zustand, Recv-Q, Send-Q, lokale Adresse, Peer. */
  const SS = [
    'LISTEN 0      4096         0.0.0.0:22        0.0.0.0:*',
    'LISTEN 0      511                *:443             *:*',
    'LISTEN 0      511             [::]:80            [::]:*',
    'LISTEN 0      244        127.0.0.1:5432       0.0.0.0:*',
  ].join('\n');

  it('liest den Port hinter dem letzten Doppelpunkt jeder Zeile', () => {
    expect(parseListeningPorts(SS)).toEqual([22, 80, 443, 5432]);
  });

  it('gibt null zurück, wenn nichts dasteht', () => {
    /* Und nicht die leere Liste. Es lauscht immer mindestens HAPM selbst —
     * eine leere Ausgabe heißt „ss fehlt", und das
     * als „alle Ports frei" zu lesen ließe die Prüfung still durchgehen und den
     * Reload scheitern. */
    expect(parseListeningPorts('')).toBeNull();
    expect(parseListeningPorts('\n  \n')).toBeNull();
  });
});

describe('bindConflict', () => {
  it('meldet den Abschnitt, der den Port schon hält', () => {
    expect(bindConflict(CONFIG, 443)).toBe('frontend https_in');
    expect(bindConflict(CONFIG, 5432)).toBe('listen pg_intern');
  });

  it('ist still bei einem freien Port', () => {
    expect(bindConflict(CONFIG, 6379)).toBeNull();
  });

  it('meldet den eigenen Abschnitt nicht', () => {
    // Sonst meldete jede Änderung, die den Port behält, einen Konflikt mit sich
    // selbst.
    expect(bindConflict(CONFIG, 5432, 'pg_intern')).toBeNull();
  });
});

describe('validateStreamInput', () => {
  it('nimmt eine vollständige Eingabe an', () => {
    expect(validateStreamInput(INPUT)).toBeNull();
  });

  it('lehnt die Ports ab, die ein Reverse-Proxy selbst braucht', () => {
    for (const port of [22, 80, 443, 8888]) {
      expect(validateStreamInput({ ...INPUT, port })).toContain(`Port ${port}`);
    }
  });

  it('lehnt balance uri ab: es liest einen Pfad, den es in mode tcp nicht gibt', () => {
    expect(
      validateStreamInput({ ...INPUT, balance: 'uri' as never })
    ).toBe('Unbekanntes Verteilverfahren.');
  });

  it('besteht auf mindestens einem Ziel', () => {
    expect(validateStreamInput({ ...INPUT, servers: [] })).toContain('Mindestens ein Ziel');
  });

  it('prüft die Absenderadressen', () => {
    expect(validateStreamInput({ ...INPUT, allowedSources: ['kein.host'] })).toContain(
      'Ungültige Absenderadresse'
    );
  });

  it('lehnt einen Port außerhalb des Bereichs ab', () => {
    expect(validateStreamInput({ ...INPUT, port: 0 })).toContain('ganze Zahl');
    expect(validateStreamInput({ ...INPUT, port: 70000 })).toContain('ganze Zahl');
  });
});

describe('addStream', () => {
  it('setzt den Abschnitt vor den BACKENDS-Endmarker der Gruppe', () => {
    const next = addStream(CONFIG, INPUT);
    const lines = next.split('\n');
    const block = lines.indexOf('listen redis_kunde');
    const marker = lines.indexOf('# END AUTO KUNDEN BACKENDS');
    expect(block).toBeGreaterThan(-1);
    expect(block).toBeLessThan(marker);
  });

  it('lehnt einen belegten Port ab, bevor irgendetwas geschrieben wird', () => {
    expect(() => addStream(CONFIG, { ...INPUT, port: 443 })).toThrow(HaproxyConfigError);
    expect(() => addStream(CONFIG, { ...INPUT, port: 5432 })).toThrow(/pg_intern/);
  });

  it('lehnt einen Namen ab, den ein Backend schon trägt', () => {
    // Ein Abschnittsname gilt über frontend/backend/listen hinweg. Sonst
    // scheiterte erst das `haproxy -c` des Vorgangs.
    expect(() => addStream(CONFIG, { ...INPUT, id: 'nextcloud_intern' })).toThrow(
      /bereits vergeben/
    );
  });

  it('lehnt eine Dienst-ID ab, die eine TCP-Weiterleitung schon trägt', () => {
    // Die Gegenrichtung: `addService` prüft denselben Namensraum.
    expect(() =>
      addService(CONFIG, {
        scope: 'KUNDEN',
        id: 'pg_intern',
        domains: ['pg.kunde.example'],
        servers: [{ name: '', target: '10.10.0.50:80', weight: null }],
        redirect: null,
        routes: [],
        balance: null,
        sticky: false,
        lockedDomains: [],
        passwordLock: null,
        responseHeaders: [],
        requestHeaders: [],
        tunnel: false,
        healthcheck: true,
      })
    ).toThrow(/bereits vergeben/);
  });

  it('liest sich vollständig zurück', () => {
    const next = addStream(CONFIG, INPUT);
    const stream = parseStreams(next).find((s) => s.id === INPUT.id)!;
    expect(stream.editable).toBe(true);
    expect(toStreamInput(stream)).toEqual(INPUT);
  });

  it('liest sich auch ohne Absenderliste und ohne Verfahren zurück', () => {
    const offen: CreateStreamInput = { ...INPUT, allowedSources: [], balance: 'roundrobin', check: false };
    const stream = parseStreams(addStream(CONFIG, offen)).find((s) => s.id === offen.id)!;
    expect(stream.editable).toBe(true);
    expect(toStreamInput(stream)).toEqual(offen);
  });
});

describe('Gewichtung', () => {
  const GEWICHTET: CreateStreamInput = {
    ...INPUT,
    servers: [
      { name: 'db1', target: '10.10.0.50:5432', weight: 3 },
      { name: 'db2', target: '10.10.0.51:5432', weight: 1 },
    ],
  };

  it('steht auf der server-Zeile und liest sich zurück', () => {
    const next = addStream(CONFIG, GEWICHTET);
    expect(next).toContain('server db1 10.10.0.50:5432 check weight 3');
    const stream = parseStreams(next).find((s) => s.id === GEWICHTET.id)!;
    expect(stream.servers.map((s) => s.weight)).toEqual([3, 1]);
    expect(toStreamInput(stream)).toEqual(GEWICHTET);
  });

  it('lehnt einen Wert außerhalb des Bereichs ab', () => {
    expect(
      validateStreamInput({ ...GEWICHTET, servers: [{ ...GEWICHTET.servers[0], weight: 999 }] })
    ).toContain('Ungültige Gewichtung');
  });

  it('macht eine Cookie-Marke nur lesbar: in mode tcp gibt es keine', () => {
    const mit = CONFIG.replace(
      '    server db1 10.10.0.50:5432 check',
      '    server db1 10.10.0.50:5432 check cookie db1'
    );
    expect(parseStreams(mit)[0].editable).toBe(false);
  });
});

describe('removeStream', () => {
  it('nimmt Kommentar und Abschnitt heraus und lässt den Rest stehen', () => {
    const next = removeStream(CONFIG, 'pg_intern');
    expect(next).not.toContain('listen pg_intern');
    expect(next).not.toContain('# AUTO: pg_intern');
    expect(next).toContain('backend nextcloud_intern');
    expect(next).toContain('# END AUTO INTERN BACKENDS');
    expect(parseStreams(next).map((s) => s.id)).toEqual(['von_hand']);
  });

  it('anlegen und wieder entfernen ergibt den Anfang', () => {
    // Die Leerzeile davor geht mit. Ohne das wüchse die Datei bei jedem Anlegen
    // und Löschen um eine weitere leere Zeile.
    expect(removeStream(addStream(CONFIG, INPUT), INPUT.id)).toBe(CONFIG);
  });

  it('meldet einen Abschnitt, den es nicht gibt', () => {
    expect(() => removeStream(CONFIG, 'gibt_es_nicht')).toThrow(HaproxyConfigError);
  });
});

describe('replaceStream', () => {
  it('ändert den Port in einem Text', () => {
    const next = replaceStream(CONFIG, 'pg_intern', {
      ...toStreamInput(parseStreams(CONFIG)[0]),
      port: 15432,
    });
    const stream = parseStreams(next).find((s) => s.id === 'pg_intern')!;
    expect(stream.port).toBe(15432);
    expect(next).not.toContain('bind :5432');
  });

  it('meldet keinen Konflikt mit sich selbst, wenn der Port bleibt', () => {
    const before = toStreamInput(parseStreams(CONFIG)[0]);
    const next = replaceStream(CONFIG, 'pg_intern', {
      ...before,
      servers: [{ name: 'db1', target: '10.10.0.55:5432', weight: null }],
    });
    expect(parseStreams(next)[0].servers.map((s) => s.target)).toEqual(['10.10.0.55:5432']);
  });
});

describe('renderStreamBlock', () => {
  it('schreibt mode und Protokollformat, bevor irgendetwas anderes kommt', () => {
    const lines = renderStreamBlock(INPUT).map((l) => l.trim());
    expect(lines.slice(1, 5)).toEqual([
      `# AUTO: ${INPUT.id}`,
      `listen ${INPUT.id}`,
      'mode tcp',
      'option tcplog',
    ]);
  });

  it('schreibt die Sperre vor die Ziele', () => {
    const lines = renderStreamBlock(INPUT);
    const rule = lines.findIndex((l) => l.includes('tcp-request connection reject'));
    const server = lines.findIndex((l) => l.includes('server redis'));
    expect(rule).toBeGreaterThan(-1);
    expect(rule).toBeLessThan(server);
  });

  it('lässt die Sperre weg, wenn keine Adresse dasteht', () => {
    expect(renderStreamBlock({ ...INPUT, allowedSources: [] }).join('\n')).not.toContain(
      'tcp-request'
    );
  });
});

describe('readStreamInput', () => {
  it('macht aus einem Rumpf eine Eingabe', () => {
    expect(
      readStreamInput({
        scope: 'KUNDEN',
        id: ' Redis_Kunde ',
        port: '6379',
        servers: [{ name: ' redis ', target: ' 10.10.0.60:6379 ', weight: null }],
        balance: '',
        check: true,
        allowedSources: [' 10.0.0.0/8 ', ''],
      })
    ).toEqual(INPUT);
  });

  it('lässt einen unbekannten Port ungültig statt ihn zu biegen', () => {
    // `parseInt` machte aus „8080abc" die 8080. Was hier ankommt, soll die
    // Prüfung ablehnen und nicht der Leser reparieren.
    expect(Number.isNaN(readStreamInput({ port: '8080abc' }).port)).toBe(true);
  });
});

describe('matchesStreamSearch', () => {
  const stream = parseStreams(CONFIG)[0];

  it('findet über Kennung, Port und Ziel', () => {
    expect(matchesStreamSearch(stream, 'pg_')).toBe(true);
    expect(matchesStreamSearch(stream, '5432')).toBe(true);
    expect(matchesStreamSearch(stream, '10.10.0.51')).toBe(true);
    expect(matchesStreamSearch(stream, 'nextcloud')).toBe(false);
  });
});
