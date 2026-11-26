import { describe, it, expect } from 'vitest';
import {
  parseScopes,
  addScope,
  removeScope,
  addService,
  removeService,
  parseHaproxyConfig,
  validateScopeName,
  scopeLabel,
  scopeSlug,
  HaproxyConfigError,
  type CreateServiceInput,
} from '@/lib/haproxy/config';
import { germanText, type Message } from '@/lib/i18n/translate';

/** Die Meldung einer Prüfung auf Deutsch, wie sie ohne Sprache herauskommt. */
const de = (message: Message | null) => (message ? germanText(message) : message);

/**
 * Die Gruppen: Marker-Paare in der Datei, sonst nichts.
 *
 * Zwei Dinge fallen hier auf und sonst erst im laufenden HAProxy: ein neuer Block,
 * der im falschen Abschnitt landet (der SERVICES-Teil MUSS im Frontend bleiben),
 * und ein Entfernen, das mehr mitnimmt als seine zwei Kommentarzeilen. Das
 * zweite ist der teure Fall — verschwindet ein Endmarker, gehört alles darüber
 * beim nächsten Lesen zum Block darunter, und der nächste Dienst wird woanders
 * eingefügt, als die Oberfläche behauptet.
 */

const CONFIG = `frontend https_in
    bind :443 ssl crt /etc/haproxy/certs/

    # Globale HTTPS-Settings
    option forwardfor

# END AUTO INTERN SERVICES

# END AUTO KUNDEN SERVICES

    default_backend nichts

# ============================================================

# END AUTO INTERN BACKENDS

# END AUTO KUNDEN BACKENDS

backend nichts
    http-request deny deny_status 404
`;

const INPUT: CreateServiceInput = {
  scope: 'TESTKUNDEN',
  id: 'shop_mueller',
  domains: ['shop-mueller.example'],
  servers: [{ name: 'mueller', target: '10.10.0.30:80', weight: null }],
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
  healthcheck: true,
  backendTls: 'off',
};

describe('parseScopes', () => {
  it('liest die vorgefundenen Blöcke in der Reihenfolge des Frontends', () => {
    const scopes = parseScopes(CONFIG);
    expect(scopes.map((s) => s.name)).toEqual(['INTERN', 'KUNDEN']);
    expect(scopes.every((s) => s.complete)).toBe(true);
  });

  it('leitet Beschriftung und Adressteil aus dem Namen im Marker ab, auch mit Trennzeichen', () => {
    // Der Name im Marker ist die einzige Quelle. Eine Tabelle mit eigenen
    // Schreibweisen daneben gibt es nicht: eine Gruppe heißt so, wie sie im
    // Marker steht, und eine neue braucht keine Änderung am Code. Die eine
    // Ausnahme ist der Name des Produkts, siehe den nächsten Test.
    expect(scopeLabel('TESTKUNDEN')).toBe('Testkunden');
    expect(scopeSlug('TESTKUNDEN')).toBe('testkunden');
    expect(scopeLabel('INTERNE-TOOLS')).toBe('Interne Tools');
    expect(scopeSlug('INTERNE-TOOLS')).toBe('interne-tools');
    expect(scopeLabel('alte_seiten')).toBe('Alte Seiten');
    expect(scopeSlug('Alte_Seiten')).toBe('alte_seiten');
  });

  it('schreibt HAPM groß, in jeder Schreibweise des Markers und nur als ganzes Wort', () => {
    // Die Gruppe der Einrichtung heißt wie das Produkt, nicht „Hapm".
    expect(scopeLabel('HAPM')).toBe('HAPM');
    expect(scopeLabel('hapm')).toBe('HAPM');
    expect(scopeLabel('Hapm')).toBe('HAPM');
    expect(scopeLabel('HAPM-INTERN')).toBe('HAPM Intern');
    expect(scopeLabel('interne_hapm_tools')).toBe('Interne HAPM Tools');
    // Ein Wort, das nur so anfängt, folgt der allgemeinen Regel.
    expect(scopeLabel('HAPMS')).toBe('Hapms');
    // Der Adressteil bleibt klein: er steht in Links und in der Historie.
    expect(scopeSlug('HAPM')).toBe('hapm');
    expect(parseScopes(CONFIG.replace(/KUNDEN/g, 'HAPM'))[1].label).toBe('HAPM');
  });

  it('kommt mit einem Bindestrich im Markernamen zurecht', () => {
    // Ein Trennzeichen, das der Marker-Regex nicht kennt, hieße nicht „andere
    // Beschriftung", sondern eine Gruppe, die in der Oberfläche gar nicht mehr
    // auftaucht — samt ihrer Dienste.
    const umbenannt = CONFIG.replace(/KUNDEN/g, 'KUNDEN-SEITEN');
    const scopes = parseScopes(umbenannt);
    expect(scopes.map((s) => s.name)).toEqual(['INTERN', 'KUNDEN-SEITEN']);
    expect(scopes[1].complete).toBe(true);
    expect(scopes[1].label).toBe('Kunden Seiten');
    expect(scopes[1].slug).toBe('kunden-seiten');

    // Und es lässt sich auch etwas darin anlegen.
    const mit = addService(umbenannt, { ...INPUT, scope: 'KUNDEN-SEITEN' });
    expect(parseHaproxyConfig(mit)[0].scope).toBe('KUNDEN-SEITEN');
  });

  it('meldet einen halben Block als unvollständig statt als Gruppe', () => {
    const halb = CONFIG.replace('# END AUTO KUNDEN BACKENDS', '# irgendwas anderes');
    const scopes = parseScopes(halb);
    expect(scopes.find((s) => s.name === 'KUNDEN')?.complete).toBe(false);
  });

  it('hält einen vorgefundenen Block ohne BEGIN-Marker für nicht entfernbar', () => {
    // Sein Anfang ist nur „hinter dem Marker davor" — beim Frontend also der
    // ganze Kopf mit bind und den globalen Zeilen.
    expect(parseScopes(CONFIG).every((s) => s.removable)).toBe(false);
  });
});

describe('addScope', () => {
  const mit = addScope(CONFIG, 'testkunden');

  it('schreibt beide Marker-Paare und liest sie zurück', () => {
    const scopes = parseScopes(mit);
    expect(scopes.map((s) => s.name)).toEqual(['INTERN', 'KUNDEN', 'TESTKUNDEN']);
    const neu = scopes.find((s) => s.name === 'TESTKUNDEN')!;
    expect(neu.complete).toBe(true);
    expect(neu.removable).toBe(true);
    expect(neu.label).toBe('Testkunden');
  });

  it('lässt den SERVICES-Block im Frontend und den BACKENDS-Block darunter', () => {
    const lines = mit.split('\n').map((l) => l.trim());
    // Vor `default_backend`, sonst stünde er außerhalb des Frontends und HAProxy
    // läse ihn als Fortsetzung eines Abschnitts, in den er nicht gehört.
    expect(lines.indexOf('# END AUTO TESTKUNDEN SERVICES')).toBeLessThan(
      lines.indexOf('default_backend nichts')
    );
    expect(lines.indexOf('# END AUTO TESTKUNDEN BACKENDS')).toBeGreaterThan(
      lines.indexOf('default_backend nichts')
    );
  });

  it('fasst die bestehenden Blöcke nicht an', () => {
    expect(parseHaproxyConfig(mit)).toEqual(parseHaproxyConfig(CONFIG));
    expect(mit).toContain('    option forwardfor');
  });

  it('nimmt danach Dienste auf', () => {
    const dienst = addService(mit, INPUT);
    const service = parseHaproxyConfig(dienst).find((s) => s.id === 'shop_mueller')!;
    expect(service.scope).toBe('TESTKUNDEN');
  });

  it('weigert sich bei einem Namen, den es schon gibt — auch anders geschrieben', () => {
    expect(() => addScope(CONFIG, 'intern')).toThrow(/bereits eine Gruppe/);
    expect(() => addScope(mit, 'TestKunden')).toThrow(/bereits eine Gruppe/);
  });

  it('weigert sich, wenn es keinen Marker gibt, an den sie anschließen könnte', () => {
    // Raten, wo im Frontend ein Block hingehört, ist genau das, was dieses Modul
    // nicht tut — dieselbe Regel wie beim HTTPS-Marker. Der Fall tritt nur ein,
    // wenn auch der Marker der globalen Einstellungen fehlt: er sagt, in welchem
    // Frontend die Dienste liegen.
    const ohne = CONFIG.split('\n')
      .filter((line) => !/END AUTO .* SERVICES/.test(line) && !line.includes('Globale HTTPS-Settings'))
      .join('\n');
    expect(() => addScope(ohne, 'testkunden')).toThrow(HaproxyConfigError);
    expect(() => addScope(ohne, 'testkunden')).toThrow(/kein einziger Marker/);
  });

  it('legt die erste Gruppe an, wenn es keine gibt, und liest dafür den HTTPS-Marker', () => {
    const ohne = CONFIG.split('\n')
      .filter((line) => !/END AUTO /.test(line))
      .join('\n');
    expect(parseScopes(ohne).filter((s) => s.complete)).toEqual([]);
    const mit = addScope(ohne, 'TESTKUNDEN');
    const scope = parseScopes(mit).find((s) => s.name === 'TESTKUNDEN');
    expect(scope?.complete).toBe(true);
    expect(parseHaproxyConfig(addService(mit, INPUT))[0].scope).toBe('TESTKUNDEN');
  });

  it('lehnt einen unbrauchbaren Namen ab, bevor irgendetwas geschrieben wird', () => {
    expect(de(validateScopeName('a'))).toMatch(/zwei Zeichen/);
    expect(de(validateScopeName('mit leerzeichen'))).toMatch(/nur a-z/);
    expect(de(validateScopeName('9anfang'))).toMatch(/nur a-z/);
    expect(de(validateScopeName('testkunden'))).toBeNull();
  });

  it('lehnt den Namen einer festen Seite ab, auch groß geschrieben', () => {
    // Die Gruppe stünde unter /reverse-proxy/<slug> und wäre hinter der Seite verborgen.
    for (const name of ['fehlerseiten', 'ZERTIFIKATE', 'Einstellungen', 'import']) {
      expect(de(validateScopeName(name))).toMatch(/Name einer Seite/);
    }
    expect(de(validateScopeName('zertifikate-alt'))).toBeNull();
  });
});

describe('removeScope', () => {
  it('macht das Anlegen rückgängig, Zeichen für Zeichen', () => {
    expect(removeScope(addScope(CONFIG, 'testkunden'), 'testkunden')).toBe(CONFIG);
  });

  it('lässt eine Gruppe mit Einträgen stehen und nennt sie', () => {
    const belegt = addService(addScope(CONFIG, 'testkunden'), INPUT);
    expect(() => removeScope(belegt, 'testkunden')).toThrow(/shop_mueller/);
    // Und geht wieder, sobald der Eintrag weg ist.
    expect(() => removeScope(removeService(belegt, 'shop_mueller'), 'testkunden')).not.toThrow();
  });

  it('fasst einen vorgefundenen Block ohne BEGIN-Marker nicht an', () => {
    expect(() => removeScope(CONFIG, 'intern')).toThrow(/nicht entfernen/);
  });

  it('meldet einen Namen, den es nicht gibt', () => {
    expect(() => removeScope(CONFIG, 'gibtsnicht')).toThrow(/steht nicht in/);
  });
});
