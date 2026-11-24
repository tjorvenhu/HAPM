import { describe, it, expect } from 'vitest';
import {
  parseHaproxyConfig,
  addService,
  replaceService,
  toCreateInput,
  certificateChanged,
  matchesSearch,
  readServiceInput,
  validateCreateInput,
  HaproxyConfigError,
  HAPROXY_PRESETS,
  type CreateServiceInput,
} from '@/lib/haproxy/config';

/**
 * Bearbeiten ist der gefährlichste der drei Vorgänge, und zwar aus einem Grund,
 * den man nicht sieht: es entfernt den Block und schreibt ihn aus der
 * Eingabemaske neu. Was die Maske nicht kennt, wäre danach weg.
 *
 * Deshalb prüft diese Datei zwei Dinge zusammen: dass das Ersetzen tut, was es
 * soll — und dass `editable` jeden Eintrag ablehnt, bei dem es etwas verlieren
 * würde.
 */

const CONFIG = `frontend https_in
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

# ============================================================

# AUTO: nextcloud_intern
backend nextcloud_intern
    http-response set-header X-Robots-Tag "noindex,nofollow"
    http-response set-header X-Permitted-Cross-Domain-Policies "none"

    server intern-nextcloud 10.10.0.3:80

# END AUTO INTERN BACKENDS

# AUTO: website_blog
backend website_blog
    option httpchk
    http-check send meth GET uri / ver HTTP/1.1 hdr Host example.net
    http-check expect status 200-399

    server blog 10.10.0.20:80 check
    server blog2 10.10.0.21:80 check

# END AUTO KUNDEN BACKENDS

backend altbestand
    server alt 10.10.0.99:8080
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

function find(text: string, id: string) {
  return parseHaproxyConfig(text).find((s) => s.id === id)!;
}

describe('replaceService', () => {
  it('ersetzt einen Eintrag, ohne mit sich selbst zu kollidieren', () => {
    // Der naheliegende Fehler wäre, erst einzufügen und dann zu entfernen. Dann
    // meldet jede Änderung, die den Namen behält, „die ID ist vergeben".
    const next = replaceService(CONFIG, 'website_blog', {
      scope: 'KUNDEN',
      id: 'website_blog',
      domains: ['example.net', 'www.example.net'],
      servers: [{ name: 'blog', target: '10.10.0.99:8080', weight: null }],
      redirect: null,
      routes: [],
      balance: null,
      sticky: false,
      lockedDomains: [],
      passwordLock: null,
      preset: 'default',
      healthcheck: true,
    });
    expect(find(next, 'website_blog').servers).toEqual([
      { name: 'blog', target: '10.10.0.99:8080', check: true, weight: null },
    ]);
    expect(parseHaproxyConfig(next).map((s) => s.id)).toContain('nextcloud_intern');
  });

  it('lässt eine Domain frei werden, die derselbe Dienst gerade abgibt', () => {
    const next = replaceService(CONFIG, 'website_blog', {
      ...INPUT,
      id: 'website_blog',
      domains: ['example.net'],
    });
    expect(find(next, 'website_blog').domains).toEqual(['example.net']);
  });

  it('kann umbenennen und dabei den Bereich wechseln', () => {
    const next = replaceService(CONFIG, 'website_blog', {
      ...INPUT,
      scope: 'INTERN',
      id: 'blog_neu',
      domains: ['example.net'],
    });
    const services = parseHaproxyConfig(next);
    expect(services.map((s) => s.id)).not.toContain('website_blog');
    const renamed = services.find((s) => s.id === 'blog_neu')!;
    expect(renamed.scope).toBe('INTERN');
    expect(renamed.aclName).toBe('host_blog_neu');
    expect(renamed.removable).toBe(true);
  });

  it('weist eine Domain ab, die einem ANDEREN Dienst gehört', () => {
    expect(() =>
      replaceService(CONFIG, 'website_blog', {
        ...INPUT,
        id: 'website_blog',
        domains: ['cloud.example.org'],
      })
    ).toThrow(/wird bereits von "nextcloud_intern" bedient/);
  });

  it('meldet einen Dienst, den es nicht gibt', () => {
    expect(() => replaceService(CONFIG, 'gibtsnicht', INPUT)).toThrow(HaproxyConfigError);
  });
});

describe('editable', () => {
  it('ist wahr für einen Eintrag, den das Formular vollständig abbildet', () => {
    const service = find(CONFIG, 'website_blog');
    expect(service.extras).toEqual([]);
    expect(service.editable).toBe(true);
  });

  it('liest das Preset aus den Header-Zeilen zurück', () => {
    expect(find(CONFIG, 'nextcloud_intern').preset).toBe('nextcloud');
    expect(find(CONFIG, 'website_blog').preset).toBe('default');
  });

  it('ist falsch, sobald der Backend-Block etwas Unbekanntes trägt', () => {
    /* Der Fall, für den das Feld existiert. `balance leastconn` taugt als
     * Beispiel nicht, das ist ein eigenes Feld — genommen ist deshalb eine
     * Zeile, die das Formular nicht kennt: sie käme beim Neuschreiben nicht
     * wieder mit.
     *
     * Ein `balance` MIT Parameter fällt aus demselben Grund durch, siehe die
     * Prüfung darunter. */
    const mit = CONFIG.replace(
      '    server blog 10.10.0.20:80 check',
      '    http-request set-header X-Von blog\n    server blog 10.10.0.20:80 check'
    );
    const service = find(mit, 'website_blog');
    expect(service.extras).toEqual(['http-request set-header X-Von blog']);
    expect(service.editable).toBe(false);
    // Löschen bleibt erlaubt — dabei geht der Block ohnehin komplett weg, und
    // der Bestätigungsdialog sagt das.
    expect(service.removable).toBe(true);
  });

  it('zählt auch Zusätze auf der server-Zeile als unbekannt', () => {
    const mit = CONFIG.replace(
      '    server blog 10.10.0.20:80 check',
      '    server blog 10.10.0.20:80 check inter 2s fall 3'
    );
    const service = find(mit, 'website_blog');
    expect(service.editable).toBe(false);
    // Gelesen wird die Zeile trotzdem: die Karte soll das Ziel zeigen.
    expect(service.servers[0].target).toBe('10.10.0.20:80');
  });

  it('nimmt eine halbe Preset-Gruppe nicht als Preset', () => {
    // Nur eine der beiden Header-Zeilen: als Preset gedeutet ginge die andere
    // beim Speichern verloren.
    const halb = CONFIG.replace(
      '    http-response set-header X-Robots-Tag "noindex,nofollow"\n',
      ''
    );
    const service = find(halb, 'nextcloud_intern');
    expect(service.preset).toBe('default');
    expect(service.editable).toBe(false);
  });

  it('ist falsch bei einer ACL, die nicht unserer Schreibweise folgt', () => {
    const andere = CONFIG.replace(
      'acl host_website_blog hdr(host),lower -i',
      'acl host_website_blog hdr(host) -i'
    );
    const service = find(andere, 'website_blog');
    expect(service.editable).toBe(false);
    // Lesen geht weiter — die Domains stehen auf der Karte.
    expect(service.domains).toHaveLength(2);
  });

  it('ist falsch für einen Eintrag außerhalb der verwalteten Blöcke', () => {
    expect(find(CONFIG, 'altbestand').editable).toBe(false);
  });

  it('was gerendert wurde, ist danach bearbeitbar — in jeder Kombination', () => {
    // Die Klammer um alles: `renderBackendBlock` und die Rücklese-Muster dürfen
    // nicht auseinanderlaufen. Wer das eine erweitert, sieht hier das andere.
    for (const preset of HAPROXY_PRESETS) {
      for (const healthcheck of [true, false]) {
        const input = { ...INPUT, preset, healthcheck };
        const label = `${preset}/${healthcheck}`;
        const service = find(addService(CONFIG, input), INPUT.id);
        expect(service.extras, label).toEqual([]);
        expect(service.editable, label).toBe(true);
        expect(service.preset, label).toBe(preset);
        expect(service.healthcheck, label).toBe(healthcheck);
        // Und das Formular bekommt exakt zurück, was hineinging.
        expect(toCreateInput(service), label).toEqual(input);
      }
    }
  });

  it('toCreateInput wirft, statt einen unbearbeitbaren Eintrag zu erfinden', () => {
    expect(() => toCreateInput(find(CONFIG, 'altbestand'))).toThrow(HaproxyConfigError);
  });
});

describe('certificateChanged', () => {
  it('ist falsch, wenn nur ein Backend-Ziel wechselt', () => {
    expect(certificateChanged(['a.example', 'www.a.example'], ['a.example', 'www.a.example'])).toBe(false);
    expect(certificateChanged(['a.example'], ['A.EXAMPLE'])).toBe(false);
  });

  it('ist wahr, sobald eine Domain dazukommt oder wegfällt', () => {
    expect(certificateChanged(['a.example'], ['a.example', 'www.a.example'])).toBe(true);
    expect(certificateChanged(['a.example', 'www.a.example'], ['a.example'])).toBe(true);
  });

  it('ist wahr, wenn nur die Reihenfolge wechselt', () => {
    // Die erste Domain ist die Hauptdomain, nach ihr heißt die PEM-Datei. Ein
    // Tausch braucht ein Zertifikat unter dem neuen Namen.
    expect(certificateChanged(['a.example', 'www.a.example'], ['www.a.example', 'a.example'])).toBe(true);
  });
});

describe('matchesSearch', () => {
  const blog = find(CONFIG, 'website_blog');

  it('findet über Domain, Dienst-ID, Backend-Name und Ziel', () => {
    expect(matchesSearch(blog, 'example.net')).toBe(true);
    expect(matchesSearch(blog, 'WWW.Example')).toBe(true);
    expect(matchesSearch(blog, 'website_')).toBe(true);
    expect(matchesSearch(blog, '10.10.0.21')).toBe(true);
    expect(matchesSearch(blog, 'blog2')).toBe(true);
  });

  it('lässt bei leerer Suche alles durch', () => {
    expect(matchesSearch(blog, '')).toBe(true);
    expect(matchesSearch(blog, '   ')).toBe(true);
  });

  it('findet nichts Fremdes', () => {
    expect(matchesSearch(blog, 'nextcloud')).toBe(false);
  });
});

describe('readServiceInput', () => {
  it('schreibt Domains klein, weil hdr(host),lower kleingeschrieben vergleicht', () => {
    // „Kunde.example" in der ACL wäre eine Domain, die nie trifft.
    expect(readServiceInput({ domains: [' Kunde.EXAMPLE ', ''] }).domains).toEqual(['kunde.example']);
  });

  it('biegt einen fehlenden Bereich nicht auf einen Vorgabewert', () => {
    const input = readServiceInput({ id: 'x', domains: ['a.example'], servers: [] });
    expect(input.scope).toBe('');
    expect(validateCreateInput(input)).not.toBeNull();
  });

  it('überlebt einen Rumpf, der gar nicht passt', () => {
    expect(readServiceInput(null).domains).toEqual([]);
    expect(readServiceInput({ servers: 'nein' }).servers).toEqual([]);
    expect(readServiceInput({ servers: [null] }).servers).toEqual([{ name: '', target: '', weight: null }]);
  });

  it('nimmt healthcheck nur als echtes true', () => {
    expect(readServiceInput({ healthcheck: 'ja' }).healthcheck).toBe(false);
    expect(readServiceInput({ healthcheck: true }).healthcheck).toBe(true);
  });
});
