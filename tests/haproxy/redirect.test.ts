import { describe, it, expect } from 'vitest';
import {
  parseHaproxyConfig,
  addService,
  replaceService,
  removeService,
  toCreateInput,
  validateCreateInput,
  readServiceInput,
  isValidRedirectUrl,
  matchesSearch,
  type CreateServiceInput,
} from '@/lib/haproxy/config';

/**
 * Eine Domain, die nicht bedient, sondern weiterschickt.
 *
 * Die Feder dieser Datei ist die Rundreise: was `renderBackendBlock` schreibt,
 * muss `parseHaproxyConfig` als Weiterleitung wiedererkennen und `toCreateInput`
 * unverändert zurückgeben. Sonst wäre der erste Klick auf „Bearbeiten" der
 * Moment, in dem aus der Weiterleitung ein Backend ohne Ziele wird.
 */

const CONFIG = `frontend https_in
    bind :443 ssl crt /etc/haproxy/certs/
    acl admin_ips src 10.0.0.1

# END AUTO INTERN SERVICES

# ============================================================

# END AUTO INTERN BACKENDS
`;

const INPUT: CreateServiceInput = {
  scope: 'INTERN',
  id: 'altdomain',
  domains: ['alte-domain.example', 'www.alte-domain.example'],
  servers: [],
  redirect: { to: 'https://example.org', keepPath: false, permanent: false },
  routes: [],
  balance: null,
  sticky: false,
  lockedDomains: [],
  passwordLock: null,
  preset: 'default',
  healthcheck: false,
};

function find(text: string, id: string) {
  return parseHaproxyConfig(text).find((s) => s.id === id)!;
}

describe('Weiterleitung statt Backend', () => {
  it('schreibt ein Backend aus genau einer Zeile', () => {
    const next = addService(CONFIG, INPUT);
    expect(next).toContain('    http-request redirect location https://example.org code 302');
    // Kein `server`, kein Healthcheck: beides braucht ein Ziel, das es nicht gibt.
    expect(next).not.toContain('server ');
    expect(next).not.toContain('option httpchk');
  });

  it('liest sich unverändert zurück', () => {
    const service = find(addService(CONFIG, INPUT), 'altdomain');
    expect(service.redirect).toEqual({
      to: 'https://example.org',
      keepPath: false,
      permanent: false,
    });
    expect(service.servers).toEqual([]);
    expect(service.editable).toBe(true);
    expect(toCreateInput(service)).toEqual(INPUT);
  });

  it('trägt Pfad und Code so, wie sie eingestellt wurden', () => {
    const input = {
      ...INPUT,
      redirect: { to: 'https://example.org/neu', keepPath: true, permanent: true },
    };
    const next = addService(CONFIG, input);
    expect(next).toContain('http-request redirect prefix https://example.org/neu code 301');
    expect(toCreateInput(find(next, 'altdomain'))).toEqual(input);
  });

  it('lässt sich sperren wie jeder andere Eintrag', () => {
    // Die Sperre hängt an der Host-ACL im Frontend und nicht am Backend. Eine
    // Weiterleitung ist dort nichts Besonderes — genau deshalb steht die Regel
    // im Backend und nicht als eigene Frontend-Zeile.
    const next = addService(CONFIG, { ...INPUT, lockedDomains: INPUT.domains });
    const service = find(next, 'altdomain');
    expect(service.lockedDomains).toEqual(INPUT.domains);
    expect(service.redirect?.to).toBe('https://example.org');
    expect(service.editable).toBe(true);
  });

  it('geht beim Umschalten auf ein Backend restlos weg', () => {
    const withRedirect = addService(CONFIG, INPUT);
    const withBackend = replaceService(withRedirect, 'altdomain', {
      ...INPUT,
      servers: [{ name: 'web', target: '10.0.0.5:80', weight: null }],
      redirect: null,
    });
    expect(withBackend).not.toContain('http-request redirect');
    expect(find(withBackend, 'altdomain').servers).toEqual([
      { name: 'web', target: '10.0.0.5:80', check: false, weight: null },
    ]);
    expect(find(withBackend, 'altdomain').redirect).toBeNull();
  });

  it('verschwindet beim Löschen mitsamt seinem Block', () => {
    const removed = removeService(addService(CONFIG, INPUT), 'altdomain');
    expect(removed).not.toContain('http-request redirect');
    expect(removed).not.toContain('altdomain');
  });

  it('findet sich über sein Ziel in der Suche', () => {
    const service = find(addService(CONFIG, INPUT), 'altdomain');
    expect(matchesSearch(service, 'example.org')).toBe(true);
  });
});

describe('Weiterleitung und Backend zusammen', () => {
  it('ist nur lesbar, wenn beides in der Datei steht', () => {
    // Von Hand geschrieben: die server-Zeile wird nie erreicht. Gelesen wird
    // das, neu geschrieben nicht — ein Speichern ließe eine der beiden weg.
    const text = `frontend https_in
    bind :443
    acl host_mix hdr(host),lower -i mix.example
    use_backend mix if host_mix

# END AUTO INTERN SERVICES

# AUTO: mix
backend mix
    http-request redirect location https://example.org code 301
    server web 10.0.0.5:80

# END AUTO INTERN BACKENDS
`;
    const service = find(text, 'mix');
    expect(service.redirect).not.toBeNull();
    expect(service.editable).toBe(false);
  });

  it('wird von der Prüfung abgelehnt', () => {
    expect(
      validateCreateInput({ ...INPUT, servers: [{ name: 'web', target: '10.0.0.5:80', weight: null }] })
    ).toMatch(/kein Backend-Ziel/);
    expect(
      validateCreateInput({
        ...INPUT,
        routes: [{ name: 'api', paths: ['/api'], servers: [], check: true }],
      })
    ).toMatch(/Pfad-Regeln/);
    expect(validateCreateInput({ ...INPUT, preset: 'coolify' })).toMatch(/Preset/);
  });
});

describe('isValidRedirectUrl', () => {
  it('nimmt an, was in eine Konfigurationszeile passt', () => {
    expect(isValidRedirectUrl('https://example.org')).toBe(true);
    expect(isValidRedirectUrl('https://example.org/neu/hier')).toBe(true);
    expect(isValidRedirectUrl('http://10.0.0.5:8080/pfad?x=1&y=2')).toBe(true);
  });

  it('lehnt ab, was die Zeile aufbräche', () => {
    // Ein `#` macht den Rest der Zeile zum Kommentar — aus `code 301` würde
    // nichts, und die Weiterleitung stünde ohne Code da.
    expect(isValidRedirectUrl('https://example.org/#anker')).toBe(false);
    // Ein Leerzeichen trennt Argumente.
    expect(isValidRedirectUrl('https://example.org/mit platz')).toBe(false);
    // Ohne Schema weiß der Browser nicht, wohin.
    expect(isValidRedirectUrl('example.org')).toBe(false);
    expect(isValidRedirectUrl('javascript:alert(1)')).toBe(false);
    expect(isValidRedirectUrl('https://example.org:70000')).toBe(false);
  });
});

describe('readServiceInput', () => {
  it('liest eine Weiterleitung aus dem Rumpf', () => {
    const input = readServiceInput({
      scope: 'INTERN',
      id: 'altdomain',
      domains: ['Alte-Domain.example'],
      redirect: { to: 'https://example.org', keepPath: true, permanent: true },
      healthcheck: true,
    });
    expect(input.redirect).toEqual({
      to: 'https://example.org',
      keepPath: true,
      permanent: true,
    });
    // Ein Healthcheck ohne Ziel prüft nichts. Normalisiert statt abgelehnt:
    // dieselbe Regel wie bei einer Wildcard als Hauptdomain.
    expect(input.healthcheck).toBe(false);
  });

  it('liest ein leeres Ziel als „keine Weiterleitung"', () => {
    expect(readServiceInput({ redirect: { to: '   ' } }).redirect).toBeNull();
    expect(readServiceInput({}).redirect).toBeNull();
  });
});
