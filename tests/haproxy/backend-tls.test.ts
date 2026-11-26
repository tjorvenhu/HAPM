import { describe, it, expect } from 'vitest';
import {
  parseHaproxyConfig,
  addService,
  replaceService,
  renderBackendBlock,
  toCreateInput,
  validateCreateInput,
  readServiceInput,
  readServerParams,
  serverParams,
  backendCheckSni,
  supportsSystemCa,
  usesSystemCa,
  serviceKind,
  type CreateServiceInput,
} from '@/lib/haproxy/config';
import { parseStreams } from '@/lib/haproxy/streams';
import { germanText, type Message } from '@/lib/i18n/translate';

const de = (message: Message | null) => (message ? germanText(message) : message);

/**
 * Ziele, die selbst HTTPS sprechen (Proxmox auf 8006, TrueNAS, eine Anwendung
 * mit eigenem Zertifikat).
 *
 * Geprüft wird hier, was `config.ts` allein beantworten kann: welche Zeile
 * geschrieben wird, dass sie als dieselbe Einstellung zurückkommt und Zeichen
 * für Zeichen gleich wieder geschrieben wird, und dass jede Abwandlung von Hand
 * den Eintrag nur lesbar macht, statt beim Speichern still umgeschrieben zu
 * werden. Ob HAProxy die Zeilen annimmt und das Ziel so erreicht, prüft
 * `pnpm haproxy:verify-tls` mit Docker.
 */

const CONFIG = `frontend https_in
    bind :443 ssl crt /etc/haproxy/certs/

# END AUTO INTERN SERVICES

# ============================================================

# END AUTO INTERN BACKENDS
`;

const INPUT: CreateServiceInput = {
  scope: 'INTERN',
  id: 'pve',
  domains: ['pve.example.org'],
  servers: [{ name: '', target: '10.0.0.5:8006', weight: null }],
  redirect: null,
  routes: [],
  balance: null,
  sticky: false,
  lockedDomains: [],
  passwordLock: null,
  responseHeaders: [],
  requestHeaders: [],
  tunnel: false,
  crowdsec: false,
  app: null,
  healthcheck: true,
  backendTls: 'insecure',
};

const find = (text: string, id: string) => parseHaproxyConfig(text).find((s) => s.id === id)!;
const serverLines = (text: string) =>
  text
    .split('\n')
    .filter((line) => /^\s+server\s/.test(line))
    .map((line) => line.trim());

describe('Schreiben', () => {
  it('schreibt HTTPS ohne Prüfung mit SNI aus dem Host und check-sni der Hauptdomain', () => {
    expect(serverLines(addService(CONFIG, INPUT))).toEqual([
      'server server1 10.0.0.5:8006 check ssl verify none sni req.hdr(host) check-sni pve.example.org',
    ]);
  });

  it('schreibt die Prüfung gegen die CAs des Systems', () => {
    const text = addService(CONFIG, { ...INPUT, backendTls: 'verify' });
    expect(serverLines(text)).toEqual([
      'server server1 10.0.0.5:8006 check ssl verify required ca-file @system-ca sni req.hdr(host) check-sni pve.example.org',
    ]);
  });

  it('schreibt die Prüfung gegen eine hinterlegte Zertifizierungsstelle mit ihrer Datei', () => {
    const text = addService(CONFIG, { ...INPUT, backendTls: 'ca:intern-root' });
    expect(serverLines(text)).toEqual([
      'server server1 10.0.0.5:8006 check ssl verify required ca-file /etc/haproxy/hapm-ca/intern-root.pem sni req.hdr(host) check-sni pve.example.org',
    ]);
  });

  it('lässt check-sni weg, wenn nicht geprüft wird', () => {
    const text = addService(CONFIG, { ...INPUT, healthcheck: false });
    expect(serverLines(text)).toEqual(['server server1 10.0.0.5:8006 ssl verify none sni req.hdr(host)']);
  });

  it('schreibt bei HTTP genau die Zeile von vorher', () => {
    const text = addService(CONFIG, { ...INPUT, backendTls: 'off' });
    expect(serverLines(text)).toEqual(['server server1 10.0.0.5:8006 check']);
  });

  it('hängt HTTPS hinter Gewichtung und Cookie-Marke an', () => {
    const text = addService(CONFIG, {
      ...INPUT,
      servers: [
        { name: 'a', target: '10.0.0.5:443', weight: 2 },
        { name: 'b', target: '10.0.0.6:443', weight: null },
      ],
      balance: 'leastconn',
      sticky: true,
      backendTls: 'verify',
    });
    expect(serverLines(text)).toEqual([
      'server a 10.0.0.5:443 check weight 2 cookie a ssl verify required ca-file @system-ca sni req.hdr(host) check-sni pve.example.org',
      'server b 10.0.0.6:443 check cookie b ssl verify required ca-file @system-ca sni req.hdr(host) check-sni pve.example.org',
    ]);
  });

  it('gibt jeder Pfad-Regel ihre eigene Einstellung', () => {
    const lines = renderBackendBlock({
      ...INPUT,
      backendTls: 'off',
      routes: [
        { name: 'api', paths: ['/api'], servers: [{ name: '', target: '10.0.0.5:8443' }], check: true, backendTls: 'insecure' },
        { name: 'ws', paths: ['/ws'], servers: [{ name: '', target: '10.0.0.5:6001' }], check: false, backendTls: 'verify' },
      ],
    }).map((line) => line.trim());
    expect(lines.filter((line) => line.startsWith('server '))).toEqual([
      'server server1 10.0.0.5:8006 check',
      'server server1 10.0.0.5:8443 check ssl verify none sni req.hdr(host) check-sni pve.example.org',
      'server server1 10.0.0.5:6001 ssl verify required ca-file @system-ca sni req.hdr(host)',
    ]);
  });

  it('setzt unter einer Wildcard als Hauptdomain keinen check-sni', () => {
    // Der Healthcheck des Dienstes entfällt dort ohnehin; der TCP-Check einer
    // Regel läuft weiter, nur ohne SNI: `*.example.org` ist kein Hostname.
    expect(backendCheckSni(true, 'insecure', '*.example.org')).toBeNull();
    const lines = renderBackendBlock({
      ...INPUT,
      domains: ['*.example.org'],
      healthcheck: false,
      routes: [{ name: 'api', paths: ['/api'], servers: [{ name: '', target: '10.0.0.5:8443' }], check: true, backendTls: 'insecure' }],
    }).map((line) => line.trim());
    expect(lines).toContain('server server1 10.0.0.5:8443 check ssl verify none sni req.hdr(host)');
  });
});

describe('Lesen und Rundreise', () => {
  const cases: [string, Partial<CreateServiceInput>][] = [
    ['ohne Prüfung, mit Healthcheck', {}],
    ['mit Prüfung, mit Healthcheck', { backendTls: 'verify' }],
    ['ohne Prüfung, ohne Healthcheck', { healthcheck: false }],
    ['mit Prüfung, ohne Healthcheck', { backendTls: 'verify', healthcheck: false }],
    ['mit hinterlegter Zertifizierungsstelle, mit Healthcheck', { backendTls: 'ca:intern-root' }],
    ['mit hinterlegter Zertifizierungsstelle, ohne Healthcheck', { backendTls: 'ca:intern-root', healthcheck: false }],
    [
      'Lastverteilung gegen eine hinterlegte Zertifizierungsstelle',
      {
        servers: [
          { name: 'a', target: '10.0.0.5:443', weight: 3 },
          { name: 'b', target: '10.0.0.6:443', weight: null },
        ],
        balance: 'leastconn',
        sticky: true,
        backendTls: 'ca:intern-root',
      },
    ],
    [
      'Pfad-Regeln mit verschiedenen Zertifizierungsstellen',
      {
        backendTls: 'ca:intern-root',
        routes: [
          { name: 'api', paths: ['/api'], servers: [{ name: 'api', target: '10.0.0.7:8443' }], check: true, backendTls: 'ca:zweite' },
          { name: 'ws', paths: ['/ws'], servers: [{ name: 'ws', target: '10.0.0.7:6001' }], check: false, backendTls: 'verify' },
        ],
      },
    ],
    [
      'Lastverteilung mit Gewichtung und Bindung',
      {
        servers: [
          { name: 'a', target: '10.0.0.5:443', weight: 3 },
          { name: 'b', target: '10.0.0.6:443', weight: 0 },
        ],
        balance: 'roundrobin',
        sticky: true,
      },
    ],
    [
      'Pfad-Regeln mit eigener Einstellung',
      {
        backendTls: 'off',
        tunnel: true,
        crowdsec: false,
        app: null,
        routes: [
          { name: 'api', paths: ['/api'], servers: [{ name: 'api', target: '10.0.0.7:8443' }], check: true, backendTls: 'verify' },
          { name: 'ws', paths: ['/ws'], servers: [{ name: 'ws', target: '10.0.0.7:6001' }], check: false, backendTls: 'insecure' },
        ],
      },
    ],
  ];

  for (const [label, over] of cases) {
    it(`${label}: bearbeitbar, dieselbe Eingabe, Zeichen für Zeichen dieselbe Datei`, () => {
      const input = { ...INPUT, servers: [{ name: 'server1', target: '10.0.0.5:8006', weight: null }], ...over };
      const text = addService(CONFIG, input);
      const service = find(text, 'pve');
      expect(service.extras).toEqual([]);
      expect(service.editable).toBe(true);
      expect(service.backendTls).toBe(input.backendTls);
      expect(toCreateInput(service)).toEqual(input);
      expect(replaceService(text, 'pve', toCreateInput(service))).toBe(text);
    });
  }

  it('meldet die Art auch an jeder Zeile', () => {
    const service = find(addService(CONFIG, { ...INPUT, backendTls: 'verify' }), 'pve');
    expect(service.servers).toEqual([
      { name: 'server1', target: '10.0.0.5:8006', check: true, weight: null, tls: 'verify' },
    ]);
  });

  it('meldet die Zertifizierungsstelle an jeder Zeile', () => {
    const service = find(addService(CONFIG, { ...INPUT, backendTls: 'ca:intern-root' }), 'pve');
    expect(service.backendTls).toBe('ca:intern-root');
    expect(service.servers.map((server) => server.tls)).toEqual(['ca:intern-root']);
  });

  it('wechselt zwischen den CAs des Systems und einer hinterlegten, ohne Reste', () => {
    const system = addService(CONFIG, { ...INPUT, backendTls: 'verify' });
    const own = replaceService(system, 'pve', { ...INPUT, backendTls: 'ca:intern-root' });
    expect(own).toBe(addService(CONFIG, { ...INPUT, backendTls: 'ca:intern-root' }));
    expect(replaceService(own, 'pve', { ...INPUT, backendTls: 'verify' })).toBe(system);
  });

  it('ändert die Art des Eintrags nicht', () => {
    // HTTPS gibt es im Reverse-Proxy- wie im Lastverteilungs-Formular. Ein
    // Ziel mit HTTPS bleibt ein Reverse-Proxy.
    expect(serviceKind(find(addService(CONFIG, INPUT), 'pve'))).toBe('proxy');
  });

  it('zieht check-sni mit, wenn sich die Hauptdomain ändert', () => {
    const text = addService(CONFIG, INPUT);
    const next = replaceService(text, 'pve', { ...INPUT, domains: ['proxmox.example.org'] });
    expect(serverLines(next)).toEqual([
      'server server1 10.0.0.5:8006 check ssl verify none sni req.hdr(host) check-sni proxmox.example.org',
    ]);
    expect(find(next, 'pve').editable).toBe(true);
  });

  it('nimmt HTTPS beim Umschalten auf HTTP restlos weg', () => {
    const text = addService(CONFIG, INPUT);
    const next = replaceService(text, 'pve', { ...INPUT, backendTls: 'off' });
    expect(serverLines(next)).toEqual(['server server1 10.0.0.5:8006 check']);
    expect(next).toBe(addService(CONFIG, { ...INPUT, backendTls: 'off' }));
  });
});

describe('Abwandlungen von Hand bleiben nur lesbar', () => {
  /** Eine Datei, wie HAPM sie schreibt, mit einer anderen server-Zeile. */
  function withServerLine(line: string, healthcheck = true): string {
    const text = addService(CONFIG, { ...INPUT, backendTls: 'off', healthcheck });
    return text.replace(/^ {4}server .*$/m, `    ${line}`);
  }

  const variants: [string, string, boolean?][] = [
    ['ssl ohne verify', 'server server1 10.0.0.5:8006 check ssl'],
    ['verify none ohne SNI', 'server server1 10.0.0.5:8006 check ssl verify none'],
    ['eine eigene CA-Datei', 'server server1 10.0.0.5:8006 check ssl verify required ca-file /etc/haproxy/ca.pem sni req.hdr(host) check-sni pve.example.org'],
    ['eine Datei im Ordner der Zertifizierungsstellen mit einem Namen, den HAPM nicht vergibt', 'server server1 10.0.0.5:8006 check ssl verify required ca-file /etc/haproxy/hapm-ca/Intern.Root.pem sni req.hdr(host) check-sni pve.example.org'],
    ['eine Datei neben dem Ordner der Zertifizierungsstellen', 'server server1 10.0.0.5:8006 check ssl verify required ca-file /etc/haproxy/hapm-ca/../certs/app.pem sni req.hdr(host) check-sni pve.example.org'],
    ['eine hinterlegte Zertifizierungsstelle ohne SNI', 'server server1 10.0.0.5:8006 check ssl verify required ca-file /etc/haproxy/hapm-ca/intern-root.pem check-sni pve.example.org'],
    ['eine hinterlegte Zertifizierungsstelle mit verifyhost', 'server server1 10.0.0.5:8006 check ssl verify required ca-file /etc/haproxy/hapm-ca/intern-root.pem sni req.hdr(host) check-sni pve.example.org verifyhost pve.lan'],
    ['eine hinterlegte Zertifizierungsstelle mit verify none', 'server server1 10.0.0.5:8006 check ssl verify none ca-file /etc/haproxy/hapm-ca/intern-root.pem sni req.hdr(host) check-sni pve.example.org'],
    ['verify required ohne ca-file', 'server server1 10.0.0.5:8006 check ssl verify required sni req.hdr(host) check-sni pve.example.org'],
    ['ein fester SNI', 'server server1 10.0.0.5:8006 check ssl verify none sni str(pve.example.org) check-sni pve.example.org'],
    ['SNI ohne Port', 'server server1 10.0.0.5:8006 check ssl verify none sni req.hdr(host),field(1,:) check-sni pve.example.org'],
    ['ALPN dahinter', 'server server1 10.0.0.5:8006 check ssl verify none sni req.hdr(host) check-sni pve.example.org alpn h2'],
    ['verifyhost dahinter', 'server server1 10.0.0.5:8006 check ssl verify required ca-file @system-ca sni req.hdr(host) check-sni pve.example.org verifyhost pve.lan'],
    ['eine andere Reihenfolge', 'server server1 10.0.0.5:8006 ssl verify none sni req.hdr(host) check check-sni pve.example.org'],
    ['check-sni einer anderen Domain', 'server server1 10.0.0.5:8006 check ssl verify none sni req.hdr(host) check-sni alt.example.org'],
    ['ohne check-sni trotz Healthcheck', 'server server1 10.0.0.5:8006 check ssl verify none sni req.hdr(host)'],
    ['check-sni ohne check', 'server server1 10.0.0.5:8006 ssl verify none sni req.hdr(host) check-sni pve.example.org', false],
    ['check-sni ohne ssl', 'server server1 10.0.0.5:8006 check check-sni pve.example.org'],
    ['check-ssl', 'server server1 10.0.0.5:8006 check check-ssl verify none'],
  ];

  for (const [label, line, healthcheck] of variants) {
    it(label, () => {
      const service = find(withServerLine(line, healthcheck ?? true), 'pve');
      expect(service.editable).toBe(false);
      expect(service.extras).toContain(line);
      expect(() => toCreateInput(service)).toThrow();
    });
  }

  it('liest verschiedene Arten in einem Backend als nicht bearbeitbar', () => {
    const text = addService(CONFIG, {
      ...INPUT,
      healthcheck: false,
      servers: [
        { name: 'a', target: '10.0.0.5:8006', weight: null },
        { name: 'b', target: '10.0.0.6:80', weight: null },
      ],
    }).replace(/^ {4}server b .*$/m, '    server b 10.0.0.6:80');
    const service = find(text, 'pve');
    expect(service.backendTls).toBe('insecure');
    expect(service.extras).toEqual(['server b 10.0.0.6:80']);
    expect(service.editable).toBe(false);
  });

  it('liest zwei verschiedene Zertifizierungsstellen in einem Backend als nicht bearbeitbar', () => {
    const text = addService(CONFIG, {
      ...INPUT,
      healthcheck: false,
      backendTls: 'ca:intern-root',
      servers: [
        { name: 'a', target: '10.0.0.5:8006', weight: null },
        { name: 'b', target: '10.0.0.6:8006', weight: null },
      ],
    }).replace(/^( {4}server b .*)intern-root\.pem/m, '$1zweite.pem');
    const service = find(text, 'pve');
    expect(service.backendTls).toBe('ca:intern-root');
    expect(service.extras).toEqual([
      'server b 10.0.0.6:8006 ssl verify required ca-file /etc/haproxy/hapm-ca/zweite.pem sni req.hdr(host)',
    ]);
    expect(service.editable).toBe(false);
  });

  it('liest eine Pfad-Regel mit einer Abwandlung als nicht bearbeitbar', () => {
    const text = addService(CONFIG, {
      ...INPUT,
      routes: [{ name: 'api', paths: ['/api'], servers: [{ name: 'api', target: '10.0.0.7:8443' }], check: false, backendTls: 'insecure' }],
    }).replace('server api 10.0.0.7:8443 ssl verify none sni req.hdr(host)', 'server api 10.0.0.7:8443 ssl verify none');
    const service = find(text, 'pve');
    expect(service.editable).toBe(false);
    expect(service.extras).toContain('server api 10.0.0.7:8443 ssl verify none');
  });
});

describe('readServerParams und serverParams', () => {
  it('sind Gegenstücke', () => {
    for (const tls of ['off', 'insecure', 'verify', 'ca:intern-root'] as const) {
      for (const check of [true, false]) {
        const checkSni = backendCheckSni(check, tls, 'app.example.org');
        const written = serverParams({ check, weight: 4, cookie: 's1', tls, checkSni });
        expect(readServerParams(written)).toEqual({ check, weight: 4, cookie: 's1', tls, checkSni, leftover: [] });
      }
    }
  });
});

describe('Prüfen und Umformen', () => {
  it('nimmt ein fehlendes Feld als HTTP', () => {
    const input = readServiceInput({ domains: ['a.example.org'], servers: [{ target: '10.0.0.1:80' }], routes: [{ name: 'x', paths: ['/x'], servers: [{ target: '10.0.0.1:81' }] }] });
    expect(input.backendTls).toBe('off');
    expect(input.routes[0].backendTls).toBe('off');
  });

  it('reicht die Werte durch', () => {
    const input = readServiceInput({
      domains: ['a.example.org'],
      servers: [{ target: '10.0.0.1:443' }],
      backendTls: 'verify',
      routes: [{ name: 'x', paths: ['/x'], servers: [{ target: '10.0.0.1:8443' }], backendTls: 'insecure' }],
    });
    expect(input.backendTls).toBe('verify');
    expect(input.routes[0].backendTls).toBe('insecure');
  });

  it('reicht eine hinterlegte Zertifizierungsstelle durch und nimmt sie an', () => {
    const input = readServiceInput({
      scope: 'INTERN',
      domains: ['a.example.org'],
      servers: [{ target: '10.0.0.1:443' }],
      backendTls: 'ca:intern-root',
      routes: [{ name: 'x', paths: ['/x'], servers: [{ target: '10.0.0.1:8443' }], backendTls: 'ca:zweite' }],
    });
    expect(input.backendTls).toBe('ca:intern-root');
    expect(input.routes[0].backendTls).toBe('ca:zweite');
    expect(validateCreateInput({ ...input, id: 'a' })).toBeNull();
  });

  it('lehnt einen Namen ab, der kein Dateiname von HAPM wäre', () => {
    for (const value of ['ca:', 'ca:../../etc/passwd', 'ca:Intern', 'ca:intern root', 'ca:a/b']) {
      expect(de(validateCreateInput({ ...INPUT, backendTls: value as never })), value).toMatch(/Unbekannte Angabe/);
      expect(
        de(
          validateCreateInput({
            ...INPUT,
            routes: [{ name: 'x', paths: ['/x'], servers: [{ name: '', target: '10.0.0.1:81' }], check: false, backendTls: value as never }],
          })
        ),
        value
      ).toMatch(/Pfad-Regel „x"/);
    }
  });

  it('lehnt einen unbekannten Wert ab, statt ihn auf HTTP zu biegen', () => {
    const input = readServiceInput({ scope: 'INTERN', domains: ['a.example.org'], servers: [{ target: '10.0.0.1:443' }], backendTls: 'yes' });
    expect(input.backendTls).toBe('yes');
    expect(de(validateCreateInput({ ...input, id: 'a' }))).toMatch(/Unbekannte Angabe/);
    expect(
      de(
        validateCreateInput({
          ...INPUT,
          routes: [{ name: 'x', paths: ['/x'], servers: [{ name: '', target: '10.0.0.1:81' }], check: false, backendTls: 'ja' as never }],
        })
      )
    ).toMatch(/Pfad-Regel „x"/);
  });

  it('nimmt HTTPS bei einer Weiterleitung nicht an', () => {
    const redirect = { ...INPUT, servers: [], healthcheck: false, redirect: { to: 'https://example.org', keepPath: false, permanent: false } };
    expect(de(validateCreateInput(redirect))).toMatch(/Weiterleitung hat keine/);
    expect(validateCreateInput({ ...redirect, backendTls: 'off' })).toBeNull();
    // Die Route biegt es wie `balance` auf den neutralen Wert.
    expect(readServiceInput({ redirect: { to: 'https://example.org' }, backendTls: 'verify' }).backendTls).toBe('off');
    expect(de(validateCreateInput({ ...redirect, backendTls: 'ca:intern-root' }))).toMatch(/Weiterleitung hat keine/);
  });

  it('kennt die Grenze für @system-ca', () => {
    expect(supportsSystemCa('2.4.22')).toBe(false);
    expect(supportsSystemCa('2.6.0')).toBe(true);
    expect(supportsSystemCa('3.4.8')).toBe(true);
    expect(supportsSystemCa(null)).toBeNull();
    expect(usesSystemCa(INPUT)).toBe(false);
    expect(usesSystemCa({ ...INPUT, backendTls: 'verify' })).toBe(true);
    expect(
      usesSystemCa({
        ...INPUT,
        routes: [{ name: 'x', paths: ['/x'], servers: [], check: false, backendTls: 'verify' }],
      })
    ).toBe(true);
    // Eine hinterlegte Zertifizierungsstelle braucht @system-ca nicht.
    expect(usesSystemCa({ ...INPUT, backendTls: 'ca:intern-root' })).toBe(false);
  });
});

describe('TCP-Weiterleitungen', () => {
  it('lesen eine ssl-Zeile als nicht bearbeitbar: dort wird durchgereicht', () => {
    const text = `listen tcp_8006
    mode tcp
    option tcplog
    bind :8006

    server server1 10.0.0.5:8006 check ssl verify none sni req.hdr(host)

# END AUTO INTERN BACKENDS
`;
    const [stream] = parseStreams(text);
    expect(stream.extras).toContain('server server1 10.0.0.5:8006 check ssl verify none sni req.hdr(host)');
    expect(stream.editable).toBe(false);
  });
});
