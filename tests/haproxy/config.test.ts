import { describe, it, expect } from 'vitest';
import {
  parseHaproxyConfig,
  addService,
  removeService,
  findDomainConflict,
  validateCreateInput,
  renderBackendBlock,
  renderServiceBlock,
  toCreateInput,
  locksEveryDomain,
  healthcheckPossible,
  readServiceInput,
  HaproxyConfigError,
  aclNameFor,
  parseHaproxyVersion,
  shortVersion,
  type CreateServiceInput,
} from '@/lib/haproxy/config';

/**
 * Die Konfiguration ist die Wahrheit, und diese Datei rechnet nach, was HAPM
 * darin ändert — ohne dass ein HAProxy antwortet.
 *
 * Das Fixture hat absichtlich die Form einer gewachsenen Datei:
 * zwei Marker-Blöcke im Frontend, zwei darunter für die Backends, ein von Hand
 * gepflegter Eintrag außerhalb beider und ein Backend, dessen Block bis zum
 * nächsten Abschnitt läuft statt bis zu einem Endmarker. Genau an diesen drei
 * Stellen geht das Ein- und Ausbauen sonst schief.
 */

const CONFIG = `global
    log /dev/log local0
    daemon

defaults
    mode http
    timeout connect 5s

# ============================================================
frontend https_in
    bind :443 ssl crt /etc/haproxy/certs/

    # AUTO: nextcloud_intern
    acl host_nextcloud_intern hdr(host),lower -i cloud.example.org
    use_backend nextcloud_intern if host_nextcloud_intern

# END AUTO INTERN SERVICES

    # AUTO: website_blog
    acl host_website_blog hdr(host),lower -i example.net www.example.net
    use_backend website_blog if host_website_blog

# END AUTO KUNDEN SERVICES

    acl host_altbestand hdr(host),lower -i alt.example.org
    use_backend altbestand if host_altbestand

    default_backend nichts

# ============================================================

# AUTO: nextcloud_intern
backend nextcloud_intern
    http-response set-header X-Robots-Tag "noindex,nofollow"

    option httpchk
    http-check send meth GET uri / ver HTTP/1.1 hdr Host cloud.example.org
    http-check expect status 200-399

    server intern-nextcloud 10.10.0.3:80 check

# END AUTO INTERN BACKENDS

# AUTO: website_blog
backend website_blog
    server blog 10.10.0.20:80 check
    server blog2 10.10.0.21:80 check

# END AUTO KUNDEN BACKENDS

backend altbestand
    server alt 10.10.0.99:8080

backend nichts
    http-request deny deny_status 404
`;

const INPUT: CreateServiceInput = {
  scope: 'KUNDEN',
  id: 'shop_mueller',
  domains: ['shop-mueller.example', 'www.shop-mueller.example'],
  servers: [{ name: 'mueller', target: '10.10.0.30:80', weight: null }],
  redirect: null,
  routes: [],
  balance: null,
  sticky: false,
  lockedDomains: [],
  passwordLock: null,
  preset: 'default',
  healthcheck: true,
};

describe('parseHaproxyConfig', () => {
  const services = parseHaproxyConfig(CONFIG);

  it('findet jede Weiche mit ihrer ACL und ihrem Backend', () => {
    expect(services.map((s) => s.id)).toEqual([
      'nextcloud_intern',
      'website_blog',
      'altbestand',
    ]);
  });

  it('ordnet den Bereich über den nächsten Endmarker zu', () => {
    expect(services[0].scope).toBe('INTERN');
    expect(services[1].scope).toBe('KUNDEN');
    // Steht hinter beiden Markern: von Hand gepflegt, gehört keinem Block.
    expect(services[2].scope).toBeNull();
  });

  it('liest die Domains hinter -i, nicht den Fetch davor', () => {
    expect(services[1].domains).toEqual(['example.net', 'www.example.net']);
  });

  it('liest Backend-Server samt check-Flag', () => {
    expect(services[1].servers).toEqual([
      { name: 'blog', target: '10.10.0.20:80', check: true, weight: null },
      { name: 'blog2', target: '10.10.0.21:80', check: true, weight: null },
    ]);
    expect(services[2].servers).toEqual([{ name: 'alt', target: '10.10.0.99:8080', check: false, weight: null }]);
  });

  it('erkennt den Healthcheck am option httpchk des Backends', () => {
    expect(services[0].healthcheck).toBe(true);
    expect(services[1].healthcheck).toBe(false);
  });

  it('hält Backend-Blöcke auseinander — der letzte endet am nächsten Abschnitt', () => {
    // `backend nichts` steht hinter `backend altbestand` und darf dessen
    // server-Zeilen nicht erben.
    expect(services[2].servers).toHaveLength(1);
  });

  it('markiert nur löschbar, was dem eigenen Namensschema folgt und im Block steht', () => {
    expect(services[0].removable).toBe(true);
    expect(services[1].removable).toBe(true);
    // Namen passen zwar (host_altbestand / altbestand), aber das Backend liegt
    // hinter beiden Endmarkern. Es wurde nicht hier angelegt.
    expect(services[2].removable).toBe(false);
  });

  it('nimmt den # AUTO-Kommentar als Herkunftsvermerk, nicht als Bedingung', () => {
    expect(services[0].auto).toBe(true);
    expect(services[2].auto).toBe(false);
  });

  it('kommt mit CRLF und einer leeren Datei zurecht', () => {
    expect(parseHaproxyConfig(CONFIG.replace(/\n/g, '\r\n'))).toHaveLength(3);
    expect(parseHaproxyConfig('')).toEqual([]);
  });
});

describe('addService', () => {
  it('setzt ACL und Weiche vor den Servicemarker des Bereichs', () => {
    const next = addService(CONFIG, INPUT).split('\n');
    const marker = next.indexOf('# END AUTO KUNDEN SERVICES');
    expect(next.slice(marker - 4, marker)).toEqual([
      '',
      '    # AUTO: shop_mueller',
      '    acl host_shop_mueller hdr(host),lower -i shop-mueller.example www.shop-mueller.example',
      '    use_backend shop_mueller if host_shop_mueller',
    ]);
  });

  it('setzt das Backend vor den Backendmarker desselben Bereichs', () => {
    const next = addService(CONFIG, INPUT);
    const lines = next.split('\n');
    const marker = lines.indexOf('# END AUTO KUNDEN BACKENDS');
    expect(lines.slice(0, marker)).toContain('backend shop_mueller');
    // Nicht in den Block der anderen Gruppe.
    const intern = lines.indexOf('# END AUTO INTERN BACKENDS');
    expect(lines.slice(0, intern)).not.toContain('backend shop_mueller');
  });

  it('ist danach wieder lesbar — und zwar als genau ein Dienst mehr', () => {
    const services = parseHaproxyConfig(addService(CONFIG, INPUT));
    expect(services).toHaveLength(4);
    const created = services.find((s) => s.id === 'shop_mueller')!;
    expect(created.scope).toBe('KUNDEN');
    expect(created.domains).toEqual(['shop-mueller.example', 'www.shop-mueller.example']);
    expect(created.servers).toEqual([{ name: 'mueller', target: '10.10.0.30:80', check: true, weight: null }]);
    expect(created.healthcheck).toBe(true);
    expect(created.removable).toBe(true);
  });

  it('weist eine belegte Dienst-ID ab', () => {
    expect(() => addService(CONFIG, { ...INPUT, id: 'website_blog' })).toThrow(
      HaproxyConfigError
    );
  });

  it('weist eine Domain ab, die schon woanders geroutet wird', () => {
    // Der teure Fall: HAProxy nähme beide ACLs an und bediente die erste. Die
    // fremde Seite verschwände, ohne dass irgendwo ein Fehler steht.
    expect(() =>
      addService(CONFIG, { ...INPUT, domains: ['WWW.Example.NET'] })
    ).toThrow(/wird bereits von "website_blog" bedient/);
  });

  it('weist eine Konfiguration ohne den passenden Marker ab', () => {
    // Halb da ist nicht da: ohne den Backendmarker landete der Backend-Block
    // irgendwo, und „irgendwo" heißt hier im Block eines fremden Kunden.
    const ohne = CONFIG.replace('# END AUTO KUNDEN BACKENDS', '# irgendwas anderes');
    expect(() => addService(ohne, INPUT)).toThrow(/keine vollständige Gruppe/);
  });

  it('vergibt fehlende Servernamen nach Position', () => {
    const block = renderBackendBlock({
      ...INPUT,
      healthcheck: false,
      servers: [{ name: '', target: '10.0.0.1:80', weight: null }, { name: '', target: '10.0.0.2:80', weight: null }],
    });
    expect(block).toContain('    server server1 10.0.0.1:80');
    expect(block).toContain('    server server2 10.0.0.2:80');
  });

  it('setzt den Host-Header des Healthchecks auf die Hauptdomain', () => {
    // Ohne ihn antwortet ein virtueller Host mit 404, und der Healthcheck nähme
    // ein funktionierendes Ziel aus dem Betrieb.
    expect(renderBackendBlock(INPUT)).toContain(
      '    http-check send meth GET uri / ver HTTP/1.1 hdr Host shop-mueller.example'
    );
  });

  it('hängt die Nextcloud-Header nur beim passenden Preset an', () => {
    const mit = renderBackendBlock({ ...INPUT, preset: 'nextcloud' }).join('\n');
    expect(mit).toContain('X-Permitted-Cross-Domain-Policies');
    expect(renderBackendBlock(INPUT).join('\n')).not.toContain('X-Robots-Tag');
  });
});

describe('removeService', () => {
  it('nimmt Kommentar, ACL, Weiche und den ganzen Backend-Block heraus', () => {
    const next = removeService(CONFIG, 'website_blog');
    expect(next).not.toContain('website_blog');
    expect(next).not.toContain('10.10.0.20:80');
    expect(next).not.toContain('10.10.0.21:80');
  });

  it('lässt die Marker stehen, hinter denen der nächste Eintrag landet', () => {
    // Der Backend-Block hat kein Ende, nur einen Anfang. Ohne die Marker als
    // Abbruchbedingung risse das Löschen sie mit heraus — und danach ließe sich
    // nichts mehr anlegen.
    const next = removeService(CONFIG, 'website_blog');
    expect(next).toContain('# END AUTO KUNDEN BACKENDS');
    expect(next).toContain('# END AUTO KUNDEN SERVICES');
    expect(() => addService(next, INPUT)).not.toThrow();
  });

  it('lässt die übrigen Dienste vollständig stehen', () => {
    const services = parseHaproxyConfig(removeService(CONFIG, 'website_blog'));
    expect(services.map((s) => s.id)).toEqual(['nextcloud_intern', 'altbestand']);
    expect(services[0].servers).toEqual([
      { name: 'intern-nextcloud', target: '10.10.0.3:80', check: true, weight: null },
    ]);
  });

  it('nimmt beim letzten Eintrag eines Blocks nicht den nächsten mit', () => {
    const services = parseHaproxyConfig(removeService(CONFIG, 'nextcloud_intern'));
    expect(services.map((s) => s.id)).toEqual(['website_blog', 'altbestand']);
  });

  it('ist rückgängig zu machen: anlegen und wieder entfernen ergibt den Anfang', () => {
    expect(removeService(addService(CONFIG, INPUT), INPUT.id)).toBe(CONFIG);
  });

  it('meldet einen Dienst, den es nicht gibt', () => {
    expect(() => removeService(CONFIG, 'gibtsnicht')).toThrow(HaproxyConfigError);
  });
});

describe('validateCreateInput', () => {
  it('nimmt eine gültige Eingabe', () => {
    expect(validateCreateInput(INPUT)).toBeNull();
  });

  it('nimmt eine Wildcard', () => {
    expect(
      validateCreateInput({ ...INPUT, domains: ['shop-mueller.example', '*.shop-mueller.example'] })
    ).toBeNull();
  });

  it('lehnt einen Stern ab, der keine Wildcard ist', () => {
    for (const domain of ['*kunde.example', 'a.*.kunde.example', '*.', '*']) {
      expect(validateCreateInput({ ...INPUT, domains: [domain] })).not.toBeNull();
    }
  });

  it('lehnt eine Wildcard auf eine TLD ab — die stellt keine CA aus', () => {
    expect(validateCreateInput({ ...INPUT, domains: ['*.de'] })).not.toBeNull();
  });

  it('bemängelt eine Wildcard als Hauptdomain NICHT — der Healthcheck geht stattdessen aus', () => {
    // `hdr Host *.kunde.example` ist kein gültiger Host-Header: das Ziel antwortete
    // mit 404, und HAProxy nähme ein funktionierendes Backend aus dem Betrieb.
    // Das ist eine Bedingung und keine Meldung — die Eingabe wird angenommen,
    // der Check fällt weg.
    expect(
      validateCreateInput({ ...INPUT, domains: ['*.kunde.example'], healthcheck: true })
    ).toBeNull();
    expect(healthcheckPossible(['*.kunde.example'])).toBe(false);
    expect(healthcheckPossible(['kunde.example', '*.kunde.example'])).toBe(true);
    // Noch nichts getippt: der Schalter bleibt bedienbar, statt beim Öffnen
    // des Dialogs gesperrt dazustehen.
    expect(healthcheckPossible([])).toBe(true);
  });

  it('nimmt den Healthcheck beim Normalisieren zurück statt die Eingabe abzulehnen', () => {
    // Die Stelle, an der Formular und Route dasselbe tun müssen: das Formular
    // sperrt den Schalter, `readServiceInput` zieht ihn zurück.
    const normalised = readServiceInput({
      scope: 'KUNDEN',
      id: 'kunde_alles',
      domains: ['*.kunde.example'],
      servers: [{ name: '', target: '10.0.0.1:80', weight: null }],
      healthcheck: true,
      preset: 'default',
    });
    expect(normalised.healthcheck).toBe(false);
  });

  it('lässt eine Adresse unter der eigenen Wildcard sperren', () => {
    expect(
      validateCreateInput({
        ...INPUT,
        domains: ['kunde.example', '*.kunde.example'],
        lockedDomains: ['intern.kunde.example'],
      })
    ).toBeNull();
    expect(
      validateCreateInput({
        ...INPUT,
        domains: ['kunde.example', '*.kunde.example'],
        lockedDomains: ['intern.fremd.example'],
      })
    ).not.toBeNull();
  });

  it('lehnt Dienst-IDs ab, die HAProxy oder das Namensschema brechen', () => {
    for (const id of ['Shop', 'shop-mueller', '_shop', 'shop mueller', '']) {
      expect(validateCreateInput({ ...INPUT, id })).not.toBeNull();
    }
  });

  it('lehnt ein Ziel ohne Port und einen Port außerhalb des Bereichs ab', () => {
    expect(validateCreateInput({ ...INPUT, servers: [{ name: '', target: '10.0.0.1', weight: null }] })).toMatch(
      /host:port/
    );
    expect(
      validateCreateInput({ ...INPUT, servers: [{ name: '', target: '10.0.0.1:99999', weight: null }] })
    ).not.toBeNull();
    expect(
      validateCreateInput({ ...INPUT, servers: [{ name: '', target: '10.0.0.1:0', weight: null }] })
    ).not.toBeNull();
  });

  it('lehnt zwei gleich benannte Server in einem Backend ab', () => {
    // HAProxy tut das auch — nur erst beim Laden, also nach dem Schreiben.
    expect(
      validateCreateInput({
        ...INPUT,
        servers: [
          { name: 'a', target: '10.0.0.1:80', weight: null },
          { name: 'a', target: '10.0.0.2:80', weight: null },
        ],
      })
    ).toMatch(/doppelt/);
  });

  it('lehnt eine doppelte Domain in derselben Eingabe ab', () => {
    expect(
      validateCreateInput({ ...INPUT, domains: ['kunde.example', 'KUNDE.example'] })
    ).toMatch(/doppelt/);
  });

  it('verlangt mindestens eine Domain und mindestens ein Ziel', () => {
    expect(validateCreateInput({ ...INPUT, domains: [] })).not.toBeNull();
    expect(validateCreateInput({ ...INPUT, servers: [] })).not.toBeNull();
  });
});

describe('findDomainConflict', () => {
  it('vergleicht ohne Groß- und Kleinschreibung', () => {
    const services = parseHaproxyConfig(CONFIG);
    expect(findDomainConflict(services, ['CLOUD.Example.ORG'])?.service.id).toBe(
      'nextcloud_intern'
    );
    expect(findDomainConflict(services, ['frei.example.org'])).toBeNull();
  });
});

describe('parseHaproxyVersion', () => {
  it('nimmt die Version und nicht die ganze Zeile', () => {
    // Die ganze Zeile in einer Zustandspille war der Grund, aus dem der
    // Servername daneben senkrecht stand.
    expect(
      parseHaproxyVersion('HAProxy version 3.0.11-1+deb13u3 2026/05/20 - https://haproxy.org/')
    ).toBe('3.0.11-1+deb13u3');
  });

  it('kennt auch die alte Schreibweise HA-Proxy', () => {
    expect(
      parseHaproxyVersion('HA-Proxy version 2.2.9-2+deb11u5 2023/04/05 - https://haproxy.org/')
    ).toBe('2.2.9-2+deb11u5');
  });

  it('ist null, wenn nichts kam — nicht der leere String', () => {
    expect(parseHaproxyVersion('')).toBeNull();
    expect(parseHaproxyVersion('bash: haproxy: command not found')).toBeNull();
  });

  it('lässt für die Anzeige die Paketrevision weg', () => {
    expect(shortVersion('3.0.11-1+deb13u3')).toBe('3.0.11');
    expect(shortVersion('3.0.11')).toBe('3.0.11');
  });
});

describe('aclNameFor', () => {
  it('ist die einzige Stelle, die aus einer Dienst-ID einen ACL-Namen macht', () => {
    expect(aclNameFor('shop_mueller')).toBe('host_shop_mueller');
  });
});

/**
 * Wildcards sind der Fall, in dem die Reihenfolge im SERVICES-Teil zum ersten
 * Mal etwas bedeutet: HAProxy nimmt die erste passende Weiche, und eine
 * Wildcard darüber passt auch für die Domains darunter. `haproxy -c` findet
 * daran nichts — deshalb rechnet das hier nach.
 */
describe('Wildcards', () => {
  const WILD: CreateServiceInput = {
    ...INPUT,
    id: 'kunde_alles',
    domains: ['kunde.example', '*.kunde.example'],
    healthcheck: false,
  };

  it('schreibt zwei ACL-Zeilen mit demselben Namen: exakt und Suffix', () => {
    expect(renderServiceBlock(WILD)).toEqual([
      '',
      '    # AUTO: kunde_alles',
      '    acl host_kunde_alles hdr(host),lower -i kunde.example',
      '    acl host_kunde_alles hdr(host),lower -m end -i .kunde.example',
      '    use_backend kunde_alles if host_kunde_alles',
    ]);
  });

  it('liest sie unverändert zurück und bleibt bearbeitbar', () => {
    const text = addService(CONFIG, WILD);
    const service = parseHaproxyConfig(text).find((s) => s.id === WILD.id)!;
    expect(service.domains).toEqual(['kunde.example', '*.kunde.example']);
    expect(service.editable).toBe(true);
    expect(toCreateInput(service)).toEqual(WILD);
  });

  it('ist rückgängig zu machen', () => {
    expect(removeService(addService(CONFIG, WILD), WILD.id)).toBe(CONFIG);
  });

  it('liest einen Endungsvergleich ohne führenden Punkt, schreibt ihn aber nicht zurück', () => {
    // `-m end -i kunde.example` trifft auch `fremdekunde.example`. Das ist nicht, was
    // dieses Modul schreibt, also wird es nur gelesen.
    const text = CONFIG.replace(
      '    acl host_altbestand hdr(host),lower -i alt.example.org',
      '    acl host_altbestand hdr(host),lower -m end -i example.org'
    );
    const service = parseHaproxyConfig(text).find((s) => s.id === 'altbestand')!;
    expect(service.editable).toBe(false);
  });

  it('setzt einen exakten Eintrag VOR eine bestehende Wildcard', () => {
    const withWildcard = addService(CONFIG, WILD);
    const exact: CreateServiceInput = {
      ...INPUT,
      id: 'kunde_app',
      domains: ['app.kunde.example'],
      healthcheck: false,
    };
    const services = parseHaproxyConfig(addService(withWildcard, exact));
    const order = services.map((s) => s.id);
    expect(order.indexOf('kunde_app')).toBeLessThan(order.indexOf('kunde_alles'));
    // Und damit greift die Weiche auch wirklich.
    expect(services.find((s) => s.id === 'kunde_app')!.shadowedBy).toBeNull();
  });

  it('setzt das engere Wildcard-Muster vor das weitere', () => {
    const wide = addService(CONFIG, WILD);
    const narrow: CreateServiceInput = {
      ...INPUT,
      id: 'kunde_intern',
      domains: ['*.intern.kunde.example'],
      healthcheck: false,
    };
    const services = parseHaproxyConfig(addService(wide, narrow));
    const order = services.map((s) => s.id);
    expect(order.indexOf('kunde_intern')).toBeLessThan(order.indexOf('kunde_alles'));
    expect(services.find((s) => s.id === 'kunde_intern')!.shadowedBy).toBeNull();
  });

  it('trägt eine Wildcard, die einen Eintrag darunter verdeckt, als Befund nach', () => {
    // Von Hand geschrieben und nicht über dieses Werkzeug: die Wildcard steht
    // oben. Umsortiert wird nichts — gesagt wird es.
    const text = CONFIG.replace(
      '    acl host_nextcloud_intern hdr(host),lower -i cloud.example.org',
      '    acl host_nextcloud_intern hdr(host),lower -m end -i .example.org'
    );
    const services = parseHaproxyConfig(text);
    expect(services.find((s) => s.id === 'altbestand')!.shadowedBy).toBe('nextcloud_intern');
    expect(services.find((s) => s.id === 'website_blog')!.shadowedBy).toBeNull();
  });

  it('sperrt über die Host-ACL nur, wenn wirklich alle Domains gemeint sind', () => {
    // Beide Listen sind einelementig und meinen das Gegenteil voneinander —
    // über die Länge gegangen wäre der ganze Dienst gesperrt gewesen.
    expect(locksEveryDomain(['*.kunde.example'], ['intern.kunde.example'])).toBe(false);
    expect(locksEveryDomain(['kunde.example', '*.kunde.example'], ['kunde.example', '*.kunde.example'])).toBe(true);
  });
});
