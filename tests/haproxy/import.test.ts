import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import {
  parseImport,
  assessImport,
  certificateLoad,
  importTextError,
  newScopeError,
  suggestScopeName,
  IMPORT_MAX_BYTES,
  LE_CERTS_PER_DOMAIN_WEEK,
  type ImportEntry,
  type ImportEnvironment,
} from '@/lib/haproxy/import';
import {
  addScope,
  addService,
  assignServiceId,
  parseHaproxyConfig,
  parseScopes,
  toCreateInput,
  validateCreateInput,
} from '@/lib/haproxy/config';
import { addStream, assignStreamId, parseStreams, toStreamInput, validateStreamInput } from '@/lib/haproxy/streams';
import { renderBaseConfig } from '@/lib/haproxy/base-config';

/**
 * Der Import einer fremden Konfiguration (`lib/haproxy/import.ts`).
 *
 * Das Fixture ist eine gewachsene Datei, wie man sie von einem Server
 * mitnimmt: zwei HTTP-Frontends, ACLs in allen üblichen Schreibweisen, eine
 * Weiterleitung, Pfad-Regeln, Lastverteilung mit Gewichten, TCP, Header,
 * `timeout tunnel`, Kommentare, eine Fortsetzungszeile, und daneben alles,
 * was bewusst nicht übernommen wird. Jeder Eintrag hat hier seine Erwartung.
 */

const SAMPLE = readFileSync('tests/haproxy/fixtures/import-sample.cfg', 'utf8');
const RESULT = parseImport(SAMPLE);

function entry(key: string): ImportEntry {
  const found = RESULT.entries.find((e) => e.key === key);
  if (!found) throw new Error(`Kein Eintrag ${key}. Da sind: ${RESULT.entries.map((e) => e.key).join(', ')}`);
  return found;
}

function skippedAt(line: number): string[] {
  return RESULT.skipped.filter((s) => s.line === line).map((s) => s.reason);
}

const FRESH = addScope(renderBaseConfig({ ipv6: false, errorStatuses: [503] }), 'IMPORTIERT');

function env(overrides: Partial<ImportEnvironment> = {}): ImportEnvironment {
  return {
    config: FRESH,
    exposure: 'public',
    dnsHooks: ['dns_cf'],
    dnsHook: null,
    acmeReady: true,
    busyPorts: {},
    ...overrides,
  };
}

describe('parseImport: was übernommen wird', () => {
  it('findet genau diese Einträge', () => {
    expect(RESULT.entries.map((e) => e.key).sort()).toEqual(
      [
        'http:a.example.org,b.example.org',
        'http:admin.example.org',
        'http:alt.example.org',
        'http:*.apps.example.org',
        'http:blog.example.org,sni.example.org',
        'http:coolify.example.org',
        'http:dead.example.org',
        'http:inline.example.org',
        'http:kunde.example,*.kunde.example',
        'http:lb.example.org',
        'http:shop.example.org,www.shop.example.org',
        'tcp:2525',
        'tcp:5432',
        'tcp:8443',
      ].sort()
    );
  });

  it('Lastverteilung mit Healthcheck, Headern und timeout tunnel; der Port in der Domain fällt weg', () => {
    const shop = entry('http:shop.example.org,www.shop.example.org');
    expect(shop.problems).toEqual([]);
    expect(shop.kind).toBe('balance');
    expect(shop.service).toMatchObject({
      domains: ['shop.example.org', 'www.shop.example.org'],
      servers: [
        { name: 'web1', target: '10.0.0.11:8080', weight: null },
        { name: 'web2', target: '10.0.0.12:8080', weight: null },
      ],
      balance: 'roundrobin',
      healthcheck: true,
      tunnel: true,
      // Anführungszeichen und das Leerzeichen darin kommen als Wert an.
      requestHeaders: [{ name: 'X-Shop', value: 'eins zwei' }],
      responseHeaders: [{ name: 'X-Frame-Options', value: 'SAMEORIGIN' }],
      redirect: null,
      routes: [],
    });
    // Die bisherige Prüfung war eine andere als die von HAPM. Das steht da.
    expect(shop.notes.join(' ')).toContain('GET /health');
  });

  it('req.hdr(Host) mit -m str und ssl_fc_sni gehen in einen Eintrag, wenn sie dasselbe Ziel haben', () => {
    const blog = entry('http:blog.example.org,sni.example.org');
    expect(blog.kind).toBe('proxy');
    expect(blog.service?.servers).toEqual([{ name: 'blog', target: '10.0.0.20:80', weight: null }]);
  });

  it('hdr_end mit führendem Punkt wird eine Wildcard', () => {
    expect(entry('http:*.apps.example.org').service?.domains).toEqual(['*.apps.example.org']);
  });

  it('hdr_dom wird Domain und Wildcard, und der Unterschied steht als Hinweis da', () => {
    const kunde = entry('http:kunde.example,*.kunde.example');
    expect(kunde.service?.domains).toEqual(['kunde.example', '*.kunde.example']);
    expect(kunde.notes.join(' ')).toContain('hdr_dom');
  });

  it('Pfad-Regeln vor der Hauptweiche werden Pfad-Regeln, timeout tunnel in jeder Schreibweise', () => {
    const coolify = entry('http:coolify.example.org');
    expect(coolify.problems).toEqual([]);
    expect(coolify.service).toMatchObject({
      servers: [{ name: 'coolify', target: '10.0.0.30:8000', weight: null }],
      tunnel: true,
      routes: [
        { name: 'terminal', paths: ['/terminal/ws'], servers: [{ name: 'coolify', target: '10.0.0.30:6002' }], check: false },
        { name: 'realtime', paths: ['/app'], servers: [{ name: 'coolify', target: '10.0.0.30:6001' }], check: false },
      ],
    });
  });

  it('Gewichte und Sitzungsbindung; ein anderer Cookie-Name ist ein Hinweis', () => {
    const lb = entry('http:lb.example.org');
    expect(lb.service).toMatchObject({
      balance: 'leastconn',
      sticky: true,
      servers: [
        { name: 'lb1', target: '10.0.0.41:80', weight: 3 },
        { name: 'lb2', target: '10.0.0.42:80', weight: 1 },
      ],
    });
    expect(lb.notes.join(' ')).toContain('HAPMSRV');
  });

  it('eine Weiche mit „or", ein Kommentar hinter der server-Zeile', () => {
    const multi = entry('http:a.example.org,b.example.org');
    expect(multi.problems).toEqual([]);
    // Bei einem Ziel entfällt die Verbindungsprüfung ohne Folgen für den
    // Verkehr, und das wird gesagt.
    expect(multi.service?.healthcheck).toBe(false);
    expect(multi.notes.join(' ')).toContain('Verbindungsprüfung entfällt');
  });

  it('eine Weiterleitung im Frontend wird eine HTTP-Weiterleitung', () => {
    const old = entry('http:alt.example.org');
    expect(old.kind).toBe('redirect');
    expect(old.service).toMatchObject({
      redirect: { to: 'https://www.example.org', keepPath: false, permanent: true },
      servers: [],
    });
  });

  it('TCP: listen mit Absenderliste und frontend mit default_backend', () => {
    expect(entry('tcp:5432').stream).toEqual({
      scope: '',
      id: '',
      port: 5432,
      servers: [
        { name: 'db1', target: '10.0.0.70:5432', weight: null },
        { name: 'db2', target: '10.0.0.71:5432', weight: null },
      ],
      balance: 'leastconn',
      check: true,
      allowedSources: ['10.0.0.0/8', '192.0.2.10'],
    });
    expect(entry('tcp:2525').stream).toMatchObject({
      port: 2525,
      servers: [{ name: 'mail', target: '10.0.0.80:25', weight: null }],
      allowedSources: [],
    });
  });

  it('jede erzeugte Eingabe besteht die Prüfung von config.ts bzw. streams.ts', () => {
    const ready = RESULT.entries.filter((e) => e.problems.length === 0);
    expect(ready.length).toBe(10);
    for (const e of ready) {
      if (e.service) expect(validateCreateInput({ ...e.service, scope: 'IMPORTIERT', id: 'x' }), e.key).toBeNull();
      if (e.stream) expect(validateStreamInput({ ...e.stream, scope: 'IMPORTIERT', id: 'x' }), e.key).toBeNull();
    }
  });
});

describe('parseImport: was nicht übernommen wird, mit Grund', () => {
  it('eine Regel für die Domain, die HAPM nicht abbildet, macht den Eintrag unvollständig', () => {
    const admin = entry('http:admin.example.org');
    expect(admin.service).toBeNull();
    expect(admin.problems.join(' ')).toContain('Zeile 48');
    expect(skippedAt(48)[0]).toContain('http-request deny');
  });

  it('eine Weiche mit Bedingung, die jede Domain treffen kann, sperrt alles darunter', () => {
    expect(skippedAt(60)[0]).toContain('beg');
    expect(entry('http:dead.example.org').problems.join(' ')).toContain('Zeile 60');
    expect(entry('http:inline.example.org').problems.join(' ')).toContain('Zeile 60');
  });

  it('eine Weiche, die nie zum Zug kam, wird genannt', () => {
    expect(skippedAt(62)[0]).toContain('kam nie zum Zug');
  });

  it('IPv6-Ziele kennt HAPM nicht', () => {
    expect(entry('http:inline.example.org').problems.join(' ')).toContain('IPv6');
  });

  it('SNI-Weichen in mode tcp nicht', () => {
    const tls = entry('tcp:8443');
    expect(tls.stream).toBeNull();
    expect(tls.problems.join(' ')).toContain('SNI');
  });

  it('global, defaults, userlist, Lua, Statistik, die Umleitung auf HTTPS, default_backend und ein unbenutztes Backend', () => {
    const reasons = RESULT.skipped.map((s) => `${s.line} ${s.reason}`).join('\n');
    expect(skippedAt(2)[0]).toContain('Globale Einstellungen');
    expect(skippedAt(5)[0]).toContain('Lua');
    expect(skippedAt(8)[0]).toContain('Vorgaben');
    expect(skippedAt(16)[0]).toContain('Benutzerlisten');
    expect(skippedAt(22)[0]).toContain('HTTPS');
    expect(skippedAt(65)[0]).toContain('unbekannte Domains');
    expect(reasons).toMatch(/Auf dieses Backend zeigt keine Weiche/);
    expect(reasons).toMatch(/Statistikseite/);
    // Die TLS-Zeile des Frontends: einmal und mit dem Satz zu den Zertifikaten.
    expect(skippedAt(25).join(' ')).toContain('Zertifikate');
  });
});

describe('parseImport: Einzelheiten', () => {
  // Mit `defaults`: ohne `mode http` dort liefen die Backends in HAProxys
  // eigener Vorgabe, und die ist tcp.
  const frontend = (rules: string, backends = 'backend web\n    server web 10.0.0.1:80\n') =>
    parseImport(`defaults\n    mode http\nfrontend f\n    bind :443 ssl crt /x/\n${rules}\n${backends}`);

  it('ein Backend ohne mode und ohne defaults läuft in tcp und passt nicht hinter ein HTTP-Frontend', () => {
    const r = parseImport(
      'frontend f\n    mode http\n    bind :443 ssl crt /x/\n    acl a hdr(host) -i a.example.org\n    use_backend web if a\nbackend web\n    server web 10.0.0.1:80\n'
    );
    expect(r.entries[0].problems.join(' ')).toContain('mode tcp');
  });

  it('Groß- und Kleinschreibung in Schlüsselwörtern und Domains', () => {
    const r = frontend('    acl h HDR(Host) -i Shop.Example.ORG\n    use_backend web if h');
    expect(r.entries[0].service?.domains).toEqual(['shop.example.org']);
  });

  it('eine Pfad-Regel unter der Hauptweiche kam nie zum Zug und fällt weg, der Eintrag bleibt', () => {
    const r = frontend(
      '    acl h hdr(host) -i a.example.org\n    acl p path_beg /api\n    use_backend web if h\n    use_backend api if h p',
      'backend web\n    server web 10.0.0.1:80\nbackend api\n    server api 10.0.0.2:80\n'
    );
    expect(r.entries[0].problems).toEqual([]);
    expect(r.entries[0].service?.routes).toEqual([]);
    expect(r.skipped.some((s) => s.reason.includes('kam nie zum Zug'))).toBe(true);
  });

  it('eine Domain, die eine Wildcard davor schon bedient: in HAPM käme sie zuerst, also nicht übernommen', () => {
    const r = frontend(
      '    acl w hdr_end(host) -i .example.org\n    acl a hdr(host) -i app.example.org\n    use_backend web if w\n    use_backend web2 if a',
      'backend web\n    server web 10.0.0.1:80\nbackend web2\n    server web 10.0.0.2:80\n'
    );
    const app = r.entries.find((e) => e.domains.includes('app.example.org'))!;
    expect(app.problems.join(' ')).toContain('greift vorher');
    expect(r.entries.find((e) => e.domains.includes('*.example.org'))!.problems).toEqual([]);
  });

  it('„unless", Negation und zwei Domain-Bedingungen zugleich werden nicht gedeutet', () => {
    const r = frontend(
      '    acl a hdr(host) -i a.example.org\n    acl b hdr(host) -i b.example.org\n    acl o src 192.0.2.1\n' +
        '    use_backend web if a !o\n    use_backend web if a b\n    use_backend web unless b'
    );
    expect(r.entries.find((e) => e.domains.includes('a.example.org'))!.problems.length).toBeGreaterThan(0);
    expect(r.entries.find((e) => e.domains.includes('b.example.org'))!.problems.length).toBeGreaterThan(0);
  });

  it('ein \\ am Zeilenende ist keine Fortsetzung: HAProxy lädt das nicht, also wird nichts verbunden', () => {
    const r = frontend(
      '    acl a hdr(host) -i a.example.org\n    use_backend web if a',
      'backend web\n    server web 10.0.0.1:80 \\\n        check\n'
    );
    expect(r.entries[0].service).toBeNull();
    expect(r.entries[0].problems.join(' ')).toContain('setzt in HAProxy keine Zeile fort');
  });

  it('Code 308 und eine Weiterleitung mit drop-query kennt HAPM nicht', () => {
    const r = frontend(
      '    acl a hdr(host) -i a.example.org\n    acl b hdr(host) -i b.example.org\n' +
        '    http-request redirect prefix https://x.example.org code 308 if a\n' +
        '    redirect location https://y.example.org drop-query if b'
    );
    expect(r.entries.every((e) => e.service === null)).toBe(true);
  });

  it('eine Weiterleitung mit prefix und ohne Code wird 302 mit Pfad', () => {
    const r = frontend('    acl a hdr(host) -i a.example.org\n    redirect prefix https://x.example.org if a');
    expect(r.entries[0].service?.redirect).toEqual({ to: 'https://x.example.org', keepPath: true, permanent: false });
  });

  it('Kommentare, auch hinter einer Zeile, und ein # in Anführungszeichen', () => {
    const r = frontend(
      '    # acl alt hdr(host) -i alt.example.org\n    acl a hdr(host) -i a.example.org # Hauptseite\n    use_backend web if a',
      'backend web\n    http-response set-header X-Note "a#b"\n    server web 10.0.0.1:80\n'
    );
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].service?.responseHeaders).toEqual([{ name: 'X-Note', value: 'a#b' }]);
  });

  it('ein Header mit Ausdruck oder Umgebungsvariable ist kein fester Text', () => {
    for (const line of ['http-request set-header X-Real-IP %[src]', 'http-request set-header X-Env "$HOME"']) {
      const r = frontend(
        '    acl a hdr(host) -i a.example.org\n    use_backend web if a',
        `backend web\n    ${line}\n    server web 10.0.0.1:80\n`
      );
      expect(r.entries[0].service, line).toBeNull();
    }
    // `%%` ist ein Prozentzeichen, kein Ausdruck.
    const ok = frontend(
      '    acl a hdr(host) -i a.example.org\n    use_backend web if a',
      'backend web\n    http-response set-header X-Rate "100%%"\n    server web 10.0.0.1:80\n'
    );
    expect(ok.entries[0].service?.responseHeaders).toEqual([{ name: 'X-Rate', value: '100%' }]);
  });

  it('Parameter auf der server-Zeile, die HAPM nicht schreibt, machen den Eintrag nicht übernehmbar', () => {
    const r = frontend(
      '    acl a hdr(host) -i a.example.org\n    use_backend web if a',
      'backend web\n    server web 10.0.0.1:443 check inter 2s ssl verify none\n'
    );
    expect(r.entries[0].problems.join(' ')).toContain('inter 2s ssl verify none');
  });

  it('timeout tunnel mit einem anderen Wert als einer Stunde', () => {
    const r = frontend(
      '    acl a hdr(host) -i a.example.org\n    use_backend web if a',
      'backend web\n    timeout tunnel 24h\n    server web 10.0.0.1:80\n'
    );
    expect(r.entries[0].problems.join(' ')).toContain('eine Stunde');
  });

  it('TCP an eine feste Adresse gebunden: HAPM bände breiter', () => {
    const r = parseImport('listen db\n    mode tcp\n    bind 10.0.0.5:5432\n    server db 10.0.0.70:5432\n');
    expect(r.entries[0].problems.join(' ')).toContain('bestimmte Adresse');
  });

  it('ein Frontend nur über HTTP: übernehmbar, mit Hinweis auf HTTPS', () => {
    const r = parseImport(
      'defaults\n    mode http\nfrontend f\n    bind :80\n    acl a hdr(host) -i a.example.org\n    use_backend web if a\nbackend web\n    server web 10.0.0.1:80\n'
    );
    expect(r.entries[0].problems).toEqual([]);
    expect(r.entries[0].notes.join(' ')).toContain('ohne TLS');
  });

  it('dieselbe Domain in HTTP und HTTPS mit demselben Ziel ist ein Eintrag ohne den Hinweis', () => {
    const r = parseImport(
      'defaults\n    mode http\n' +
        'frontend a\n    bind :80\n    acl h hdr(host) -i a.example.org\n    use_backend web if h\n' +
        'frontend b\n    bind :443 ssl crt /x/\n    acl h hdr(host) -i a.example.org\n    use_backend web if h\n' +
        'backend web\n    server web 10.0.0.1:80\n'
    );
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].problems).toEqual([]);
    expect(r.entries[0].notes.join(' ')).not.toContain('ohne TLS');
  });

  it('dieselbe Domain in zwei Frontends auf verschiedene Ziele ist nicht übernehmbar', () => {
    const r = parseImport(
      'defaults\n    mode http\n' +
        'frontend a\n    bind :80\n    acl h hdr(host) -i a.example.org\n    use_backend web if h\n' +
        'frontend b\n    bind :443 ssl crt /x/\n    acl h hdr(host) -i a.example.org\n    use_backend web2 if h\n' +
        'backend web\n    server web 10.0.0.1:80\nbackend web2\n    server web 10.0.0.2:80\n'
    );
    expect(r.entries[0].problems.join(' ')).toContain('woanders hin');
  });
});

describe('assessImport: gegen den Stand von HAPM', () => {
  it('in einer frischen Installation ist alles Übernehmbare übernehmbar, mit Kennungen ohne Doppel', () => {
    const assessed = assessImport(RESULT.entries, env());
    const ready = assessed.filter((e) => e.state === 'ready');
    expect(ready).toHaveLength(10);
    const ids = ready.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('shop_example_org');
    expect(ids).toContain('tcp_5432');
  });

  it('eine belegte Domain und ein belegter Port sind Konflikte', () => {
    let config = addService(FRESH, {
      ...RESULT.entries.find((e) => e.key === 'http:lb.example.org')!.service!,
      scope: 'IMPORTIERT',
      id: 'schon_da',
    });
    config = addStream(config, { ...entry('tcp:5432').stream!, scope: 'IMPORTIERT', id: 'pg' });
    const assessed = assessImport(RESULT.entries, env({ config, busyPorts: { 2525: 'Auf diesem Server lauscht bereits ein anderer Dienst darauf.' } }));
    const state = (key: string) => assessed.find((e) => e.key === key)!;
    expect(state('http:lb.example.org')).toMatchObject({ state: 'conflict' });
    expect(state('http:lb.example.org').reason).toContain('schon_da');
    expect(state('tcp:5432')).toMatchObject({ state: 'conflict' });
    expect(state('tcp:2525').state).toBe('conflict');
    expect(state('http:shop.example.org,www.shop.example.org').state).toBe('ready');
  });

  it('ohne DNS-Zugangsdaten ist eine Wildcard hier nicht möglich, intern jeder Eintrag mit Domain', () => {
    const publicNoHooks = assessImport(RESULT.entries, env({ dnsHooks: [] }));
    expect(publicNoHooks.find((e) => e.key === 'http:*.apps.example.org')!.state).toBe('blocked');
    expect(publicNoHooks.find((e) => e.key === 'http:lb.example.org')!.state).toBe('ready');

    const internal = assessImport(RESULT.entries, env({ dnsHooks: [], exposure: 'internal' }));
    expect(internal.find((e) => e.key === 'http:lb.example.org')!.state).toBe('blocked');
    expect(internal.find((e) => e.key === 'tcp:5432')!.state).toBe('ready');
  });

  it('ohne acme.sh ist kein Eintrag mit Domain möglich', () => {
    const assessed = assessImport(RESULT.entries, env({ acmeReady: false }));
    expect(assessed.filter((e) => e.state === 'ready').every((e) => e.kind === 'tcp')).toBe(true);
  });
});

describe('Rundweg: angelegt in einer frischen Grundkonfiguration, zurückgelesen genauso', () => {
  it('jede übernehmbare Eingabe lässt sich schreiben, ist danach bearbeitbar und liest sich identisch zurück', () => {
    let config = FRESH;
    const taken: string[] = [];
    const expected = new Map<string, unknown>();
    for (const e of RESULT.entries.filter((x) => x.problems.length === 0)) {
      if (e.service) {
        const id = assignServiceId(config, e.service, taken);
        const input = { ...e.service, scope: 'IMPORTIERT', id };
        config = addService(config, input);
        expected.set(id, input);
      } else if (e.stream) {
        const id = assignStreamId(config, e.stream.port, taken);
        const input = { ...e.stream, scope: 'IMPORTIERT', id };
        config = addStream(config, input);
        expected.set(id, input);
      }
    }
    expect(expected.size).toBe(10);

    const services = parseHaproxyConfig(config);
    const streams = parseStreams(config);
    for (const [id, input] of expected) {
      const service = services.find((s) => s.id === id);
      if (service) {
        expect(service.editable, `${id}: ${service.extras.join(', ')}`).toBe(true);
        expect(toCreateInput(service), id).toEqual(input);
        continue;
      }
      const stream = streams.find((s) => s.id === id)!;
      expect(stream.editable, `${id}: ${stream.extras.join(', ')}`).toBe(true);
      expect(toStreamInput(stream), id).toEqual(input);
    }
  });
});

describe('Gruppe, Kontingent, Text', () => {
  it('schlägt IMPORTIERT vor und nicht IMPORT, dessen Seite unter dieser hier läge', () => {
    expect(suggestScopeName(parseScopes(FRESH))).toBe('IMPORTIERT_2');
    expect(suggestScopeName([])).toBe('IMPORTIERT');
    expect(newScopeError('import', [])).toContain('Seite unter Reverse-Proxy');
    expect(newScopeError('logs', [])).not.toBeNull();
    expect(newScopeError('importiert', parseScopes(FRESH))).toContain('gibt es schon');
    expect(newScopeError('kunden', parseScopes(FRESH))).toBeNull();
  });

  it('zählt die Zertifikate je registrierter Domain und warnt an den Grenzen von Let\'s Encrypt', () => {
    const few = certificateLoad([{ domains: ['a.example.org'] }, { domains: ['*.b.example.org'] }, { domains: [] }]);
    expect(few).toMatchObject({ certificates: 2, busiest: { domain: 'example.org', count: 2 }, near: false, exceeds: false });

    const many = (n: number) =>
      certificateLoad(Array.from({ length: n }, (_, i) => ({ domains: [`s${i}.example.org`] })));
    expect(many(LE_CERTS_PER_DOMAIN_WEEK / 2).near).toBe(true);
    expect(many(LE_CERTS_PER_DOMAIN_WEEK).exceeds).toBe(false);
    expect(many(LE_CERTS_PER_DOMAIN_WEEK + 1).exceeds).toBe(true);
  });

  it('nimmt nur Text bis 1 MB', () => {
    expect(importTextError('')).not.toBeNull();
    expect(importTextError('a'.repeat(IMPORT_MAX_BYTES + 1))).toContain('MB');
    expect(importTextError('global\u0000')).toContain('Textdatei');
    expect(importTextError(SAMPLE)).toBeNull();
  });
});
