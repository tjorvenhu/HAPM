import { describe, it, expect } from 'vitest';
import {
  addService,
  assignServiceId,
  headerLine,
  legacyPresetError,
  parseGlobalHeaders,
  parseHaproxyConfig,
  readHeaderLine,
  readServiceInput,
  renderBackendBlock,
  renderServiceBlock,
  replaceService,
  serviceIdFor,
  toCreateInput,
  validateCreateInput,
  validateHeaderRule,
  validateNewService,
  HEADERS_MAX,
  HEADER_NAME_MAX,
  HEADER_VALUE_MAX,
  SERVICE_ID_MAX,
  TUNNEL_LINE,
  type CreateServiceInput,
  type HeaderRule,
} from '@/lib/haproxy/config';
import { readServiceRequest } from '@/lib/haproxy/password-lock';
import {
  assignStreamId,
  streamIdFor,
  validateNewStream,
  validateStreamInput,
  type CreateStreamInput,
} from '@/lib/haproxy/streams';
import { hapmServiceInput } from '@/lib/setup/rules';
import { germanText, type Message } from '@/lib/i18n/translate';

/** Die Meldung einer Prüfung auf Deutsch, wie sie ohne Sprache herauskommt. */
const de = (message: Message | null) => (message ? germanText(message) : message);

/**
 * Was an die Stelle der Presets getreten ist: einzelne Header und der Schalter
 * für lange Verbindungen, dazu die Dienst-ID, die sich aus der Hauptdomain
 * ergibt.
 *
 * Die Klammer um alles ist `LEGACY`: genau so hat HAPM vor dem Umbau die
 * Presets „Nextcloud" und „Coolify" geschrieben (erzeugt mit dem alten
 * `addService`). Solche Dateien liegen auf bestehenden Servern, und ein
 * Speichern ohne Änderung darf an ihnen kein Zeichen ändern.
 */

const BASE = `frontend https_in
    bind :443 ssl crt /etc/haproxy/certs/

# BEGIN AUTO KUNDEN SERVICES
# END AUTO KUNDEN SERVICES

    default_backend nichts

# BEGIN AUTO KUNDEN BACKENDS
# END AUTO KUNDEN BACKENDS

backend nichts
    http-request deny deny_status 404
`;

const LEGACY = `frontend https_in
    bind :443 ssl crt /etc/haproxy/certs/

# BEGIN AUTO KUNDEN SERVICES

    # AUTO: cloud
    acl host_cloud hdr(host),lower -i cloud.example.org
    use_backend cloud if host_cloud

    # AUTO: coolify
    acl host_coolify hdr(host),lower -i coolify.example.org
    acl path_coolify_terminal path_beg /terminal/ws
    use_backend coolify_terminal if host_coolify path_coolify_terminal
    use_backend coolify if host_coolify
# END AUTO KUNDEN SERVICES

    default_backend nichts

# BEGIN AUTO KUNDEN BACKENDS

# AUTO: cloud
backend cloud
    http-response set-header X-Robots-Tag "noindex,nofollow"
    http-response set-header X-Permitted-Cross-Domain-Policies "none"

    option httpchk
    http-check send meth GET uri / ver HTTP/1.1 hdr Host cloud.example.org
    http-check expect status 200-399

    server web 10.0.0.5:80 check

# AUTO: coolify
backend coolify
    timeout tunnel 1h

    server web 10.0.0.5:80

backend coolify_terminal
    timeout tunnel 1h

    server coolify 10.0.0.5:6002 check
# END AUTO KUNDEN BACKENDS

backend nichts
    http-request deny deny_status 404
`;

/** Die beiden Einträge, wie ein Aufrufer aus der Preset-Zeit sie über
 *  `/api/internal` geschickt hat. */
const LEGACY_BODIES = [
  {
    scope: 'KUNDEN',
    id: 'cloud',
    domains: ['cloud.example.org'],
    servers: [{ name: 'web', target: '10.0.0.5:80' }],
    preset: 'nextcloud',
    healthcheck: true,
  },
  {
    scope: 'KUNDEN',
    id: 'coolify',
    domains: ['coolify.example.org'],
    servers: [{ name: 'web', target: '10.0.0.5:80' }],
    routes: [
      {
        name: 'terminal',
        paths: ['/terminal/ws'],
        servers: [{ name: 'coolify', target: '10.0.0.5:6002' }],
        check: true,
      },
    ],
    preset: 'coolify',
    healthcheck: false,
  },
];

const INPUT: CreateServiceInput = {
  scope: 'KUNDEN',
  id: '',
  domains: ['shop.example.org'],
  servers: [{ name: 'web', target: '10.0.0.9:80', weight: null }],
  redirect: null,
  routes: [],
  balance: null,
  sticky: false,
  lockedDomains: [],
  passwordLock: null,
  responseHeaders: [],
  requestHeaders: [],
  tunnel: false,
  healthcheck: false,
  backendTls: 'off',
};

function find(text: string, id: string) {
  return parseHaproxyConfig(text).find((s) => s.id === id)!;
}

describe('Einträge aus der Preset-Zeit', () => {
  it('liest die Nextcloud-Zeilen als zwei Header der Antwort zurück', () => {
    const cloud = find(LEGACY, 'cloud');
    expect(cloud.responseHeaders).toEqual([
      { name: 'X-Robots-Tag', value: 'noindex,nofollow' },
      { name: 'X-Permitted-Cross-Domain-Policies', value: 'none' },
    ]);
    expect(cloud.requestHeaders).toEqual([]);
    expect(cloud.tunnel).toBe(false);
    expect(cloud.editable).toBe(true);
  });

  it('liest die Coolify-Zeile als Schalter, in jedem Backend des Eintrags', () => {
    const coolify = find(LEGACY, 'coolify');
    expect(coolify.tunnel).toBe(true);
    expect(coolify.responseHeaders).toEqual([]);
    expect(coolify.extras).toEqual([]);
    expect(coolify.editable).toBe(true);
  });

  it('schreibt beide byte-genau zurück', () => {
    for (const id of ['cloud', 'coolify']) {
      const input = toCreateInput(find(LEGACY, id));
      expect(LEGACY, id).toContain(renderServiceBlock(input).join('\n'));
      expect(LEGACY, id).toContain(renderBackendBlock(input).join('\n'));
    }
    // Der letzte Eintrag einer Gruppe bleibt auch an seiner Stelle. Ein
    // früherer wandert beim Speichern ans Ende der Gruppe (`replaceService`),
    // seine Zeilen bleiben dieselben.
    expect(replaceService(LEGACY, 'coolify', toCreateInput(find(LEGACY, 'coolify')))).toBe(LEGACY);
  });

  it('nimmt `preset` über die interne API an und schreibt dieselben Zeilen wie früher', () => {
    let text = BASE;
    for (const body of LEGACY_BODIES) {
      const input = readServiceRequest(body);
      expect(de(validateCreateInput(input))).toBeNull();
      text = addService(text, input);
    }
    expect(text).toBe(LEGACY);
  });

  it('übersetzt jedes frühere Preset in seine Zusätze', () => {
    const base = { scope: 'KUNDEN', id: 'x', domains: ['x.example'] };
    expect(readServiceInput({ ...base, preset: 'default' })).toMatchObject({
      responseHeaders: [],
      requestHeaders: [],
      tunnel: false,
    });
    expect(readServiceInput({ ...base, preset: 'coolify' }).tunnel).toBe(true);
    expect(readServiceInput({ ...base, preset: 'nextcloud' }).responseHeaders).toHaveLength(2);
    // Ohne `preset` gilt, was in den neuen Feldern steht.
    expect(readServiceInput({ ...base, tunnel: true }).tunnel).toBe(true);
    expect(readServiceInput(base).tunnel).toBe(false);
  });

  it('lässt einen ausdrücklich genannten Header neben dem Preset gewinnen', () => {
    const input = readServiceInput({
      scope: 'KUNDEN',
      id: 'x',
      domains: ['x.example'],
      preset: 'nextcloud',
      responseHeaders: [{ name: 'x-robots-tag', value: 'none' }],
    });
    expect(input.responseHeaders).toEqual([
      { name: 'x-robots-tag', value: 'none' },
      { name: 'X-Permitted-Cross-Domain-Policies', value: 'none' },
    ]);
  });

  it('lehnt ein Preset ab, das es nie gab, statt es als „keins" zu lesen', () => {
    expect(de(legacyPresetError({ preset: 'wordpress' }))).toMatch(/Unbekanntes Preset/);
    expect(de(legacyPresetError({ preset: 'nextcloud' }))).toBeNull();
    expect(de(legacyPresetError({}))).toBeNull();
    expect(de(legacyPresetError(null))).toBeNull();
    expect(() => readServiceRequest({ ...LEGACY_BODIES[0], preset: 'wordpress' })).toThrow(
      /Unbekanntes Preset/
    );
  });

  it('nennt in Antworten kein `preset` mehr', () => {
    expect(find(LEGACY, 'cloud')).not.toHaveProperty('preset');
  });
});

describe('Header schreiben und lesen', () => {
  const roundTrip = (direction: 'request' | 'response', rule: HeaderRule) =>
    readHeaderLine(headerLine(direction, rule));

  it('schreibt einen gewöhnlichen Wert in Anführungszeichen', () => {
    expect(headerLine('response', { name: 'X-Frame-Options', value: 'SAMEORIGIN' })).toBe(
      'http-response set-header X-Frame-Options "SAMEORIGIN"'
    );
    expect(headerLine('request', { name: 'X-Api', value: 'zwei Wörter' })).toBe(
      'http-request set-header X-Api "zwei Wörter"'
    );
  });

  it('maskiert %, damit der Wert kein Log-Format wird', () => {
    // Unmaskiert würde `%[src]` die Adresse des Besuchers und `%T` eine Uhrzeit.
    expect(headerLine('request', { name: 'X-A', value: '50% %[src] %T' })).toBe(
      'http-request set-header X-A "50%% %%[src] %%T"'
    );
  });

  it('maskiert Anführungszeichen, $ und den Backslash', () => {
    const BS = '\\';
    expect(headerLine('response', { name: 'X-A', value: `q"x $HOME C:${BS}pfad ende${BS}` })).toBe(
      `http-response set-header X-A "q${BS}"x ${BS}$HOME C:${BS}${BS}pfad ende${BS}${BS}"`
    );
  });

  it('liest jeden geschriebenen Wert unverändert zurück', () => {
    const BS = '\\';
    for (const value of [
      'noindex,nofollow',
      "default-src 'self'; img-src * data:",
      '100% "echt" $HOME %[src] #kein-Kommentar',
      `C:${BS}pfad`,
      `a${BS} b`,
      `ende${BS}`,
      `${BS}"`,
      '%%',
    ]) {
      for (const direction of ['request', 'response'] as const) {
        expect(roundTrip(direction, { name: 'X-Wert', value }), value).toEqual({
          direction,
          rule: { name: 'X-Wert', value },
        });
      }
    }
  });

  it('lässt eine Zeile fremd, die nicht so geschrieben worden wäre', () => {
    // Von Hand: ein echter Ausdruck. Als Header gelesen hieße er beim
    // Speichern `%%[src]`, und aus der Adresse würde der Text „%[src]".
    expect(readHeaderLine('http-request set-header X-Real-IP "%[src]"')).toBeNull();
    expect(readHeaderLine('http-request set-header X-Real-IP %[src]')).toBeNull();
    expect(readHeaderLine('http-response set-header X-A "b" if { path_beg /x }')).toBeNull();
    expect(readHeaderLine('http-response set-header X-A "$HOME"')).toBeNull();
    expect(readHeaderLine('http-response set-header X-A ""')).toBeNull();
    expect(readHeaderLine('http-response add-header X-A "b"')).toBeNull();
    expect(readHeaderLine('http-response  set-header X-A "b"')).toBeNull();
  });

  it('macht einen Eintrag mit fremder Header-Zeile nur lesbar und lässt die Zeile stehen', () => {
    const text = LEGACY.replace(
      '    server web 10.0.0.5:80 check',
      '    http-request set-header X-Real-IP "%[src]"\n    server web 10.0.0.5:80 check'
    );
    const cloud = find(text, 'cloud');
    expect(cloud.extras).toEqual(['http-request set-header X-Real-IP "%[src]"']);
    expect(cloud.requestHeaders).toEqual([]);
    expect(cloud.editable).toBe(false);
  });

  it('nimmt einen doppelten Header nicht in die Liste, sondern als fremde Zeile', () => {
    const text = LEGACY.replace(
      '    http-response set-header X-Permitted-Cross-Domain-Policies "none"',
      '    http-response set-header X-Permitted-Cross-Domain-Policies "none"\n    http-response set-header x-robots-tag "all"'
    );
    const cloud = find(text, 'cloud');
    expect(cloud.responseHeaders).toHaveLength(2);
    expect(cloud.extras).toEqual(['http-response set-header x-robots-tag "all"']);
    expect(cloud.editable).toBe(false);
  });

  it('verlangt dieselben Zusätze in jedem Backend des Eintrags', () => {
    // Eine Pfad-Regel ohne das Timeout: neu geschrieben bekäme sie es.
    const text = LEGACY.replace(
      'backend coolify_terminal\n    timeout tunnel 1h\n',
      'backend coolify_terminal\n'
    );
    expect(find(text, 'coolify').editable).toBe(false);
  });

  it('schreibt das Timeout, dann die Anfrage, dann die Antwort', () => {
    const block = renderBackendBlock({
      ...INPUT,
      id: 'shop',
      tunnel: true,
      responseHeaders: [{ name: 'X-Frame-Options', value: 'DENY' }],
      requestHeaders: [{ name: 'X-Api', value: '2' }],
    }).map((line) => line.trim());
    const at = (line: string) => block.indexOf(line);
    expect(at(TUNNEL_LINE)).toBeGreaterThan(-1);
    expect(at(TUNNEL_LINE)).toBeLessThan(at('http-request set-header X-Api "2"'));
    expect(at('http-request set-header X-Api "2"')).toBeLessThan(
      at('http-response set-header X-Frame-Options "DENY"')
    );
  });
});

describe('validateHeaderRule', () => {
  const ok = (rule: HeaderRule) => expect(de(validateHeaderRule(rule)), JSON.stringify(rule)).toBeNull();
  const bad = (rule: HeaderRule, message: RegExp) =>
    expect(de(validateHeaderRule(rule)), JSON.stringify(rule)).toMatch(message);

  it('nimmt übliche Namen und Werte', () => {
    ok({ name: 'X-Frame-Options', value: 'SAMEORIGIN' });
    ok({ name: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' });
    ok({ name: 'X-1', value: '1' });
    ok({ name: 'A'.repeat(HEADER_NAME_MAX), value: 'x'.repeat(HEADER_VALUE_MAX) });
  });

  it('lehnt Namen ab, die kein Token sind', () => {
    for (const name of ['', 'X Frame', 'X:Frame', 'X_Frame', '-X', 'X-Ä', 'X"A']) {
      bad({ name, value: 'a' }, /Ungültiger Header-Name/);
    }
    bad({ name: 'A'.repeat(HEADER_NAME_MAX + 1), value: 'a' }, /länger als/);
  });

  it('lehnt Header der Übertragung ab', () => {
    for (const name of ['Content-Length', 'transfer-encoding', 'Connection', 'Upgrade', 'TE']) {
      bad({ name, value: 'a' }, /Übertragung/);
    }
  });

  it('lehnt Steuerzeichen, Nicht-ASCII, Leerwert und Überlänge ab', () => {
    for (const value of ['a\nb', 'a\rb', 'a\tb', 'a\u0000b', 'a\u007fb', 'Grüße']) {
      bad({ name: 'X-A', value }, /Zeichen, das hier nicht geht/);
    }
    bad({ name: 'X-A', value: '' }, /braucht einen Wert/);
    bad({ name: 'X-A', value: ' a' }, /Leerzeichen/);
    bad({ name: 'X-A', value: 'x'.repeat(HEADER_VALUE_MAX + 1) }, /länger als/);
  });

  it('lehnt in der Eingabe doppelte Namen und zu viele Zeilen ab', () => {
    expect(
      de(validateCreateInput({
        ...INPUT,
        id: 'shop',
        responseHeaders: [
          { name: 'X-A', value: '1' },
          { name: 'x-a', value: '2' },
        ],
      }))
    ).toMatch(/doppelt/);
    // Dieselbe Richtung zählt, die andere nicht: an das Ziel und an den
    // Besucher sind zwei Dinge.
    expect(
      de(validateCreateInput({
        ...INPUT,
        id: 'shop',
        responseHeaders: [{ name: 'X-A', value: '1' }],
        requestHeaders: [{ name: 'X-A', value: '1' }],
      }))
    ).toBeNull();
    const many = Array.from({ length: HEADERS_MAX + 1 }, (_, i) => ({ name: `X-${i}`, value: '1' }));
    expect(de(validateCreateInput({ ...INPUT, id: 'shop', requestHeaders: many }))).toMatch(/mehr als/);
  });

  it('wirft leere Zeilen aus dem Formular weg, eine halbe bleibt und fällt auf', () => {
    const input = readServiceInput({
      ...INPUT,
      id: 'shop',
      responseHeaders: [
        { name: '', value: '' },
        { name: 'X-A', value: '' },
      ],
    });
    expect(input.responseHeaders).toEqual([{ name: 'X-A', value: '' }]);
    expect(de(validateCreateInput(input))).toMatch(/braucht einen Wert/);
  });
});

describe('serviceIdFor', () => {
  it('macht aus der Hauptdomain eine ID', () => {
    expect(serviceIdFor('shop.example.org')).toBe('shop_example_org');
    expect(serviceIdFor(' Shop.Example.ORG ')).toBe('shop_example_org');
    expect(serviceIdFor('mein-shop.example')).toBe('mein_shop_example');
    expect(serviceIdFor('1und1.example')).toBe('1und1_example');
  });

  it('setzt vor eine Wildcard ein Präfix, statt mit der Basis zu kollidieren', () => {
    expect(serviceIdFor('*.example.org')).toBe('wildcard_example_org');
    expect(serviceIdFor('example.org')).toBe('example_org');
  });

  it('fasst Sonderzeichen zu einem Unterstrich zusammen und schneidet die Ränder ab', () => {
    expect(serviceIdFor('a..b--c.example')).toBe('a_b_c_example');
    expect(serviceIdFor('xn--bcher-kva.example')).toBe('xn_bcher_kva_example');
    expect(serviceIdFor('.a.example.')).toBe('a_example');
    expect(serviceIdFor('***')).toBe('dienst');
  });

  it('kürzt auf die Höchstlänge, ohne mit einem Unterstrich zu enden', () => {
    const long = `${'a'.repeat(30)}.${'b'.repeat(30)}.example`;
    const id = serviceIdFor(long);
    expect(id.length).toBeLessThanOrEqual(SERVICE_ID_MAX);
    expect(id).toBe(`${'a'.repeat(30)}_${'b'.repeat(17)}`);
    const edge = `${'a'.repeat(SERVICE_ID_MAX - 1)}.example`;
    expect(serviceIdFor(edge)).toBe('a'.repeat(SERVICE_ID_MAX - 1));
  });

  it('zählt hoch, wenn die ID vergeben ist, und bleibt dabei in der Länge', () => {
    expect(serviceIdFor('shop.example.org', ['shop_example_org'])).toBe('shop_example_org_2');
    expect(
      serviceIdFor('shop.example.org', ['SHOP_EXAMPLE_ORG', 'shop_example_org_2'])
    ).toBe('shop_example_org_3');
    const long = `${'a'.repeat(60)}.example`;
    const first = serviceIdFor(long);
    const second = serviceIdFor(long, [first]);
    expect(second).toBe(`${'a'.repeat(SERVICE_ID_MAX - 2)}_2`);
    expect(second.length).toBe(SERVICE_ID_MAX);
  });

  it('ergibt immer eine gültige ID', () => {
    for (const domain of ['*.example.org', 'a.example', '0.example', 'ÄÖÜ.example']) {
      expect(de(validateCreateInput({ ...INPUT, id: serviceIdFor(domain) })), domain).toBeNull();
    }
  });
});

describe('assignServiceId', () => {
  const text = addService(BASE, { ...INPUT, id: 'shop_example_org' });

  it('nimmt die abgeleitete ID, wenn sie frei ist', () => {
    expect(assignServiceId(BASE, INPUT)).toBe('shop_example_org');
  });

  it('zählt hoch, wenn die Datei die ID schon trägt', () => {
    // `shop-example.org` ergibt dieselbe Basis wie `shop.example.org`.
    expect(assignServiceId(text, { ...INPUT, domains: ['shop-example.org'] })).toBe(
      'shop_example_org_2'
    );
  });

  it('zählt hoch, wenn ein laufender Vorgang die ID schon bekommen hat', () => {
    expect(assignServiceId(BASE, INPUT, ['shop_example_org'])).toBe('shop_example_org_2');
    expect(assignServiceId(text, INPUT, ['shop_example_org_2'])).toBe('shop_example_org_3');
  });

  it('prüft auch die Namen der Pfad-Regeln und fremde Abschnitte', () => {
    // Ein Backend, das so heißt wie die Regel des neuen Eintrags hieße.
    const withBackend = BASE.replace(
      /^backend nichts/m,
      'backend app_example_org_api\n    server x 10.0.0.1:80\n\nbackend nichts'
    );
    const routes = [{ name: 'api', paths: ['/api'], servers: [{ name: '', target: '10.0.0.1:81' }], check: true, backendTls: 'off' as const }];
    expect(assignServiceId(withBackend, { domains: ['app.example.org'], routes: [] })).toBe(
      'app_example_org'
    );
    expect(assignServiceId(withBackend, { domains: ['app.example.org'], routes })).toBe(
      'app_example_org_2'
    );
    // Eine TCP-Weiterleitung teilt sich den Namensraum.
    const withListen = BASE.replace(
      /^backend nichts/m,
      'listen db_example_org\n    bind :5432\n    mode tcp\n\nbackend nichts'
    );
    expect(assignServiceId(withListen, { domains: ['db.example.org'], routes: [] })).toBe(
      'db_example_org_2'
    );
  });

  it('ergibt eine ID, unter der sich der Eintrag auch anlegen lässt', () => {
    const id = assignServiceId(text, { ...INPUT, domains: ['shop-example.org'] });
    const next = addService(text, { ...INPUT, id, domains: ['shop-example.org'] });
    expect(find(next, id).domains).toEqual(['shop-example.org']);
  });
});

describe('Die interne API: `id` ist freiwillig', () => {
  const body = {
    scope: 'KUNDEN',
    domains: ['shop.example.org'],
    servers: [{ name: 'web', target: '10.0.0.9:80' }],
  };

  it('nimmt einen Rumpf ohne `id` beim Anlegen an', () => {
    const draft = readServiceRequest(body);
    expect(draft.id).toBe('');
    expect(de(validateNewService(draft))).toBeNull();
    // Geschrieben wird nie ohne: erst die Vorabprüfung vergibt sie.
    expect(de(validateCreateInput(draft))).toMatch(/Dienst-ID/);
    const id = assignServiceId(BASE, draft);
    expect(find(addService(BASE, { ...draft, id }), 'shop_example_org').domains).toEqual([
      'shop.example.org',
    ]);
  });

  it('behält eine mitgegebene `id` und prüft sie wie bisher', () => {
    expect(readServiceRequest({ ...body, id: 'Mein_Shop' }).id).toBe('mein_shop');
    expect(de(validateNewService(readServiceRequest({ ...body, id: 'mein shop' })))).toMatch(/Dienst-ID/);
    expect(de(validateNewService(readServiceRequest({ ...body, id: '_x' })))).toMatch(/Dienst-ID/);
  });
});

describe('Header der globalen Einstellungen', () => {
  const text = `frontend https_in
    bind :443 ssl crt /etc/haproxy/certs/
    http-response set-header alt-svc "h3=\\":443\\""

    # Globale HTTPS-Settings
    http-response set-header Strict-Transport-Security "max-age=31536000"
    http-request set-header X-Forwarded-Proto https
    http-request set-header X-Forwarded-Port 443 if { ssl_fc }
    http-response set-header strict-transport-security "doppelt"

# BEGIN AUTO KUNDEN SERVICES
# END AUTO KUNDEN SERVICES

backend nichts
    http-response set-header X-Backend "nicht global"
`;

  it('liest die Header des ganzen Frontends, ohne die mit Bedingung', () => {
    expect(parseGlobalHeaders(text)).toEqual({
      request: ['X-Forwarded-Proto'],
      response: ['alt-svc', 'Strict-Transport-Security'],
    });
  });

  it('findet nichts ohne Marker', () => {
    expect(parseGlobalHeaders('frontend x\n    http-response set-header A b\n')).toEqual({
      request: [],
      response: [],
    });
  });
});

describe('Das Ziel der Einrichtung', () => {
  it('ist genau ein Backend ohne Zusätze', () => {
    const input = hapmServiceInput('hapm.example.org', 7080);
    expect(input).toMatchObject({ id: 'hapm', responseHeaders: [], requestHeaders: [], tunnel: false });
    const block = renderBackendBlock(input).join('\n');
    expect(block.match(/^backend /gm)).toHaveLength(1);
    expect(block).not.toContain('set-header');
    expect(block).not.toContain('timeout tunnel');
  });
});

describe('Die Kennung einer TCP-Weiterleitung', () => {
  it('ergibt sich aus dem Port, mit Zähler bei Dopplung', () => {
    expect(streamIdFor(5432)).toBe('tcp_5432');
    expect(streamIdFor(5432, ['tcp_5432'])).toBe('tcp_5432_2');
    const text = BASE.replace(
      /^backend nichts/m,
      'backend tcp_5432\n    server x 10.0.0.1:80\n\nbackend nichts'
    );
    expect(assignStreamId(text, 5432)).toBe('tcp_5432_2');
    expect(assignStreamId(BASE, 5432, ['tcp_5432'])).toBe('tcp_5432_2');
  });

  it('ist beim Anlegen freiwillig, beim Ändern nicht', () => {
    const input: CreateStreamInput = {
      scope: 'KUNDEN',
      id: '',
      port: 5432,
      servers: [{ name: 'db', target: '10.0.0.5:5432', weight: null }],
      balance: null,
      check: true,
      allowedSources: [],
    };
    expect(de(validateNewStream(input))).toBeNull();
    expect(de(validateStreamInput(input))).toMatch(/Kennung/);
  });
});
