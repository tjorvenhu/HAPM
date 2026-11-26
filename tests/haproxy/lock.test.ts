import { describe, it, expect } from 'vitest';
import {
  parseHaproxyConfig,
  parseGlobalSettings,
  applyGlobalSettings,
  addService,
  removeService,
  replaceService,
  toCreateInput,
  validateGlobalSettings,
  validateCreateInput,
  isValidSourceAddress,
  lockRuleFor,
  ADMIN_ACL,
  ADMIN_MARKER,
  HaproxyConfigError,
  type CreateServiceInput,
  type GlobalSettingsInput,
} from '@/lib/haproxy/config';
import { germanText, type Message } from '@/lib/i18n/translate';

/** Die Meldung einer Prüfung auf Deutsch, wie sie ohne Sprache herauskommt. */
const de = (message: Message | null) => (message ? germanText(message) : message);

/**
 * Die Sperre auf Admin-IPs.
 *
 * EINE ACL je Frontend, eine `http-request deny`-Regel je gesperrtem Eintrag.
 * Zwei Dinge daran können eine Maschine lahmlegen, und beide fallen erst beim
 * nächsten Start von HAProxy auf:
 *
 *  - Eine Regel, deren ACL es nicht (mehr) gibt: „unknown acl", die ganze Datei
 *    wird abgelehnt. Deshalb geht die Regel beim Löschen des Dienstes mit, und
 *    deshalb lässt sich die Adressliste nicht leeren, solange jemand darauf
 *    zeigt.
 *  - Eine ACL, die NACH ihrer ersten Verwendung steht: dasselbe Ergebnis.
 *    Deshalb wird sie am Kopf des Frontends eingefügt und nicht beim ersten
 *    Dienst, der sie braucht.
 */

const CONFIG = `frontend https_in
    bind :443 ssl crt /etc/haproxy/certs/

    # Globale HTTPS-Settings
    option forwardfor

# END AUTO INTERN SERVICES

# END AUTO KUNDEN SERVICES

# ============================================================

# END AUTO INTERN BACKENDS

# END AUTO KUNDEN BACKENDS
`;

const SETTINGS: GlobalSettingsInput = {
  httpsLines: ['option forwardfor'],
  adminIps: ['203.0.113.7', '10.0.0.0/8'],
};

const SERVICE: CreateServiceInput = {
  scope: 'INTERN',
  id: 'panel',
  domains: ['panel.example.org'],
  servers: [{ name: 'panel', target: '10.10.0.4:3000', weight: null }],
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

/** Eine Konfiguration mit gesetzten Admin-IPs. */
const WITH_IPS = applyGlobalSettings(CONFIG, SETTINGS);

function find(text: string, id: string) {
  return parseHaproxyConfig(text).find((s) => s.id === id)!;
}

describe('Admin-IPs', () => {
  it('legt die ACL am Kopf des Frontends an, mit Marker', () => {
    const lines = WITH_IPS.split('\n').map((l) => l.trim());
    expect(lines).toContain(ADMIN_MARKER);
    expect(lines).toContain(`acl ${ADMIN_ACL} src 203.0.113.7 10.0.0.0/8`);

    // Vor allen Diensten: eine ACL nach ihrer ersten Verwendung lässt HAProxy
    // die Datei mit „unknown acl" ablehnen.
    expect(lines.indexOf(`acl ${ADMIN_ACL} src 203.0.113.7 10.0.0.0/8`)).toBeLessThan(
      lines.indexOf('# END AUTO INTERN SERVICES')
    );
    // Und nach dem bind, nicht davor.
    expect(lines.findIndex((l) => l.startsWith('bind '))).toBeLessThan(lines.indexOf(ADMIN_MARKER));
  });

  it('liest die Adressen wieder ein', () => {
    expect(parseGlobalSettings(WITH_IPS).adminIps).toEqual(['203.0.113.7', '10.0.0.0/8']);
    expect(parseGlobalSettings(CONFIG).adminIps).toEqual([]);
  });

  it('ändert eine bestehende Zeile, statt eine zweite anzulegen', () => {
    const next = applyGlobalSettings(WITH_IPS, { ...SETTINGS, adminIps: ['198.51.100.1'] });
    expect(next.split('\n').filter((l) => l.includes(`acl ${ADMIN_ACL} src`))).toHaveLength(1);
    expect(parseGlobalSettings(next).adminIps).toEqual(['198.51.100.1']);
  });

  it('nimmt ACL und Marker weg, wenn die Liste geleert wird', () => {
    // `acl admin_ips src` ohne Adresse ist ein Syntaxfehler.
    const next = applyGlobalSettings(WITH_IPS, { ...SETTINGS, adminIps: [] });
    expect(next).not.toContain(ADMIN_ACL);
    expect(next).not.toContain(ADMIN_MARKER);
  });

  it('lässt die Liste nicht leeren, solange ein Eintrag darauf zeigt', () => {
    const mit = addService(WITH_IPS, { ...SERVICE, lockedDomains: SERVICE.domains });
    expect(parseGlobalSettings(mit).lockedServices).toEqual(['panel']);
    expect(() => applyGlobalSettings(mit, { ...SETTINGS, adminIps: [] })).toThrow(/panel/);
  });

  it('fasst zwei ACL-Zeilen nicht an', () => {
    const doppelt = WITH_IPS.replace(
      `acl ${ADMIN_ACL} src 203.0.113.7 10.0.0.0/8`,
      `acl ${ADMIN_ACL} src 203.0.113.7\n    acl ${ADMIN_ACL} src 10.0.0.0/8`
    );
    expect(parseGlobalSettings(doppelt).adminEditable).toBe(false);
    expect(() => applyGlobalSettings(doppelt, SETTINGS)).toThrow(/mehr als einmal/);
  });
});

describe('Sperren eines Dienstes', () => {
  const locked = addService(WITH_IPS, { ...SERVICE, lockedDomains: SERVICE.domains });

  it('schreibt genau eine Deny-Regel und liest sie zurück', () => {
    expect(locked).toContain(`    ${lockRuleFor('host_panel')}`);
    const service = find(locked, 'panel');
    expect(service.lockedDomains).toEqual(SERVICE.domains);
    expect(service.extras).toEqual([]);
    expect(service.editable).toBe(true);
    expect(toCreateInput(service)).toEqual({ ...SERVICE, lockedDomains: SERVICE.domains });
  });

  it('steht vor der Weiche, damit man sie beim Lesen zuerst sieht', () => {
    const lines = locked.split('\n').map((l) => l.trim());
    expect(lines.indexOf(lockRuleFor('host_panel'))).toBeLessThan(
      lines.indexOf('use_backend panel if host_panel')
    );
  });

  it('lässt sich ohne Adressen nicht setzen', () => {
    // Sonst zeigte die Regel auf eine ACL, die es nicht gibt — HAProxy lehnt
    // dann die ganze Datei ab, und zwar erst beim `haproxy -c` des Vorgangs.
    expect(() => addService(CONFIG, { ...SERVICE, lockedDomains: SERVICE.domains })).toThrow(/keine Admin-IPs/);
  });

  it('geht beim Umschalten wieder weg', () => {
    const offen = replaceService(locked, 'panel', { ...SERVICE, lockedDomains: [] });
    expect(offen).not.toContain('http-request deny');
    expect(find(offen, 'panel').lockedDomains).toEqual([]);
  });

  it('geht beim Löschen mit', () => {
    // Bliebe die Regel stehen, zeigte sie auf `host_panel` — und das gibt es
    // nach dem Löschen nicht mehr.
    const zurueck = removeService(locked, 'panel');
    expect(zurueck).not.toContain('http-request deny');
    expect(zurueck).toBe(WITH_IPS);
  });

  it('macht eine fremde Regel auf derselben ACL zum extras-Eintrag', () => {
    const fremd = locked.replace(
      `    ${lockRuleFor('host_panel')}`,
      '    http-request set-header X-Kunde ja if host_panel'
    );
    const service = find(fremd, 'panel');
    expect(service.lockedDomains).toEqual([]);
    expect(service.extras).toContain('http-request set-header X-Kunde ja if host_panel');
    expect(service.editable).toBe(false);
    // Löschen bleibt erlaubt und nimmt die Regel mit: die ACL geht ohnehin weg.
    expect(service.removable).toBe(true);
    expect(removeService(fremd, 'panel')).not.toContain('X-Kunde');
  });
});

describe('Sperren einzelner Domains', () => {
  /** Ein Eintrag mit zwei Domains, von denen nur die zweite gesperrt ist. */
  const ZWEI: CreateServiceInput = {
    ...SERVICE,
    domains: ['kunde.example', 'intern.kunde.example'],
    lockedDomains: ['intern.kunde.example'],
  };
  const teilweise = addService(WITH_IPS, ZWEI);

  it('schreibt eine eigene ACL statt der Host-ACL', () => {
    // Über `host_panel` ginge es nicht: die trägt beide Domains, und gesperrt
    // wäre damit auch die offene.
    expect(teilweise).toContain('    acl lock_panel hdr(host),lower -i intern.kunde.example');
    expect(teilweise).toContain(`    ${lockRuleFor('lock_panel')}`);
    expect(teilweise).not.toContain(lockRuleFor('host_panel'));
  });

  it('liest genau diese Domain zurück und bleibt bearbeitbar', () => {
    const service = find(teilweise, 'panel');
    expect(service.lockedDomains).toEqual(['intern.kunde.example']);
    expect(service.extras).toEqual([]);
    expect(service.editable).toBe(true);
    expect(toCreateInput(service)).toEqual(ZWEI);
  });

  it('zählt als gesperrter Dienst für die Admin-IPs', () => {
    // Sonst ließe sich die Adressliste leeren, und die Regel zeigte ins Leere.
    expect(parseGlobalSettings(teilweise).lockedServices).toEqual(['panel']);
  });

  it('nimmt die eigene ACL beim Umstellen auf „alle" wieder weg', () => {
    const alle = replaceService(teilweise, 'panel', { ...ZWEI, lockedDomains: ZWEI.domains });
    expect(alle).not.toContain('lock_panel');
    expect(alle).toContain(lockRuleFor('host_panel'));
    expect(find(alle, 'panel').lockedDomains).toEqual(ZWEI.domains);
  });

  it('räumt ACL und Regel beim Öffnen und beim Löschen ab', () => {
    const offen = replaceService(teilweise, 'panel', { ...ZWEI, lockedDomains: [] });
    expect(offen).not.toContain('lock_panel');
    expect(offen).not.toContain('http-request deny');

    // Bliebe die ACL beim Löschen stehen, wäre sie eine Karteileiche; bliebe
    // die Regel stehen, lehnte HAProxy die ganze Datei ab.
    const zurueck = removeService(teilweise, 'panel');
    expect(zurueck).not.toContain('lock_panel');
    expect(zurueck).toBe(WITH_IPS);
  });

  it('lehnt eine Domain ab, die dem Eintrag nicht gehört', () => {
    // Sie wäre eine ACL auf eine fremde Domain: der Verkehr dorthin geht
    // woanders hin, und die Sperre stünde wirkungslos in der Datei.
    expect(de(validateCreateInput({ ...ZWEI, lockedDomains: ['fremd.example'] }))).toMatch(
      /gehört nicht zu diesem Eintrag/
    );
  });

  it('ist nur lesbar, wenn die ACL Domains trägt, die der Eintrag nicht hat', () => {
    const fremd = teilweise.replace(
      'acl lock_panel hdr(host),lower -i intern.kunde.example',
      'acl lock_panel hdr(host),lower -i intern.kunde.example fremd.example'
    );
    const service = find(fremd, 'panel');
    expect(service.editable).toBe(false);
    expect(service.extras.join(' ')).toContain('fremd.example');
  });
});

describe('isValidSourceAddress', () => {
  it('nimmt Adressen und Netze', () => {
    expect(isValidSourceAddress('203.0.113.7')).toBe(true);
    expect(isValidSourceAddress('10.0.0.0/8')).toBe(true);
    expect(isValidSourceAddress('2001:db8::1')).toBe(true);
    expect(isValidSourceAddress('2001:db8::/32')).toBe(true);
  });

  it('lehnt ab, was HAProxy ablehnen würde', () => {
    expect(isValidSourceAddress('10.0.0.256')).toBe(false);
    expect(isValidSourceAddress('10.0.0.0/33')).toBe(false);
    expect(isValidSourceAddress('example.org')).toBe(false);
    expect(isValidSourceAddress('')).toBe(false);
    // Ein Leerzeichen wäre in der ACL eine zweite Adresse.
    expect(isValidSourceAddress('10.0.0.1 10.0.0.2')).toBe(false);
  });

  it('wird von der Prüfung der Einstellungen benutzt', () => {
    expect(de(validateGlobalSettings({ ...SETTINGS, adminIps: ['10.0.0.256'] }))).toMatch(
      /Keine gültige Adresse/
    );
    expect(de(validateGlobalSettings({ ...SETTINGS, adminIps: ['10.0.0.1', '10.0.0.1'] }))).toMatch(
      /steht doppelt/
    );
    expect(de(validateGlobalSettings(SETTINGS))).toBeNull();
  });
});

describe('HaproxyConfigError', () => {
  it('ist die Klasse, an der die Route den Benutzerfehler erkennt', () => {
    expect(() => addService(CONFIG, { ...SERVICE, lockedDomains: SERVICE.domains })).toThrow(HaproxyConfigError);
  });
});
