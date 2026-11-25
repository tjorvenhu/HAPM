import { describe, it, expect } from 'vitest';
import { renderBaseConfig } from '@/lib/haproxy/base-config';
import {
  applyGlobalSettings,
  parseGlobalSettings,
  parseProtection,
  geoBlockCountries,
  validateProtection,
  protectionLines,
  PROTECTION_MARKER,
  HaproxyConfigError,
  EMPTY_PROTECTION,
  type AccessProtection,
  type GlobalSettingsInput,
} from '@/lib/haproxy/config';
import { countryNetworks, addressInNetwork, geoBlockFileContent, knownCountries } from '@/lib/geoip/networks';
import { lockoutReason } from '@/lib/haproxy/protection-guard';
import type { GeoTable } from '@/lib/geoip/format';
import { germanText, type Message } from '@/lib/i18n/translate';

/**
 * Der Zugriffsschutz: gesperrte Adressen, Länder und die Ratenbegrenzung als
 * ein Block im HTTPS-Frontend. Geprüft wird vor allem der Rundlauf (was
 * geschrieben wird, kommt genauso zurück, und ein zweites Speichern ändert
 * nichts) und die Stelle: vor allen Regeln der Dienste, hinter der Admin-ACL,
 * nie im HTTP-Frontend mit der ACME-Prüfung.
 */

const de = (message: Message | null) => (message ? germanText(message) : message);

const BASE = renderBaseConfig({ ipv6: false, errorStatuses: [403, 404, 429] });
const HTTPS_LINES = parseGlobalSettings(BASE).httpsLines!;

const FULL: AccessProtection = {
  blockedIps: ['203.0.113.7', '198.51.100.0/24'],
  blockedCountries: ['CN', 'RU'],
  rateLimit: { requests: 300, period: '10s' },
};

function input(protection: AccessProtection | undefined, adminIps: string[] = []): GlobalSettingsInput {
  return { httpsLines: HTTPS_LINES, adminIps, ...(protection ? { protection } : {}) };
}

function section(text: string, name: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`frontend ${name}`));
  let end = start + 1;
  while (end < lines.length && !/^(frontend|backend|global|defaults|listen)\b/.test(lines[end])) end++;
  return lines.slice(start, end).join('\n');
}

describe('Zugriffsschutz in haproxy.cfg', () => {
  it('liest eine Datei ohne Block als leeren Schutz und lässt sie unverändert', () => {
    expect(parseProtection(BASE)).toEqual(EMPTY_PROTECTION);
    expect(applyGlobalSettings(BASE, input(EMPTY_PROTECTION))).toBe(BASE);
    expect(applyGlobalSettings(BASE, input(undefined))).toBe(BASE);
  });

  it('schreibt den Block ins HTTPS-Frontend und liest ihn genauso zurück', () => {
    const next = applyGlobalSettings(BASE, input(FULL));
    const https = section(next, 'public_https');
    expect(https).toContain(`    ${PROTECTION_MARKER}`);
    expect(https).toContain('    acl hapm_blocked_ips src 203.0.113.7 198.51.100.0/24');
    expect(https).toContain('    http-request deny deny_status 403 if hapm_blocked_ips');
    expect(https).toContain(
      '    acl hapm_blocked_countries src -f /etc/haproxy/hapm-geo/CN.lst -f /etc/haproxy/hapm-geo/RU.lst'
    );
    expect(https).toContain('    stick-table type ipv6 size 100k expire 20s store http_req_rate(10s)');
    expect(https).toContain('    http-request deny deny_status 429 if { sc_http_req_rate(1) gt 300 }');
    // Ohne Admin-IPs gibt es keine ACL, auf die eine Ausnahme zeigen könnte.
    expect(next).not.toContain('!admin_ips');
    // Die ACME-Prüfung im HTTP-Frontend bleibt offen.
    expect(section(next, 'public_http')).not.toContain('hapm_blocked');

    expect(parseProtection(next)).toEqual(FULL);
    expect(applyGlobalSettings(next, input(FULL))).toBe(next);
  });

  it('steht vor den Regeln unter den HTTPS-Einstellungen', () => {
    const lines = applyGlobalSettings(BASE, input(FULL)).split('\n');
    expect(lines.findIndex((l) => l.trim() === PROTECTION_MARKER)).toBeLessThan(
      lines.findIndex((l) => l.trim() === '# Globale HTTPS-Settings')
    );
  });

  it('nimmt die Admin-IPs von Länder- und Ratensperre aus, nicht von der Adresssperre', () => {
    const next = applyGlobalSettings(BASE, input(FULL, ['192.0.2.10']));
    expect(next).toContain('http-request deny deny_status 403 if hapm_blocked_ips\n');
    expect(next).toContain('http-request deny deny_status 403 if hapm_blocked_countries !admin_ips');
    expect(next).toContain('http-request deny deny_status 429 if { sc_http_req_rate(1) gt 300 } !admin_ips');
    // Die ACL steht vor ihrer ersten Verwendung.
    expect(next.indexOf('acl admin_ips')).toBeLessThan(next.indexOf(PROTECTION_MARKER));
    expect(parseProtection(next)).toEqual(FULL);
    expect(applyGlobalSettings(next, input(FULL, ['192.0.2.10']))).toBe(next);
  });

  it('nimmt die Ausnahme mit, wenn die Admin-IPs geleert werden, auch ohne Feld', () => {
    const mit = applyGlobalSettings(BASE, input(FULL, ['192.0.2.10']));
    const ohne = applyGlobalSettings(mit, input(undefined, []));
    expect(ohne).not.toContain('!admin_ips');
    expect(ohne).not.toMatch(/^\s+acl admin_ips/m);
    expect(parseProtection(ohne)).toEqual(FULL);
  });

  it('setzt den Block hinter eine später angelegte Admin-ACL', () => {
    const erst = applyGlobalSettings(BASE, input(FULL));
    const dann = applyGlobalSettings(erst, input(undefined, ['192.0.2.10']));
    expect(dann.indexOf('acl admin_ips')).toBeLessThan(dann.indexOf(PROTECTION_MARKER));
  });

  it('entfernt den Block wieder spurlos', () => {
    const mit = applyGlobalSettings(BASE, input(FULL));
    expect(applyGlobalSettings(mit, input(EMPTY_PROTECTION))).toBe(BASE);
  });

  it('teilt lange Listen auf mehrere Zeilen, weil HAProxy nur 64 Wörter je Zeile liest', () => {
    const many: AccessProtection = {
      ...EMPTY_PROTECTION,
      blockedIps: Array.from({ length: 100 }, (_, i) => `10.0.${i}.1`),
      blockedCountries: Array.from({ length: 25 }, (_, i) => `A${String.fromCharCode(65 + i)}`),
    };
    const lines = protectionLines(many, false);
    expect(lines.filter((l) => l.startsWith('acl hapm_blocked_ips'))).toHaveLength(3);
    expect(lines.filter((l) => l.startsWith('acl hapm_blocked_countries'))).toHaveLength(2);
    for (const line of lines) expect(line.split(/\s+/).length).toBeLessThanOrEqual(64);
    const next = applyGlobalSettings(BASE, input(many));
    expect(parseProtection(next)).toEqual(many);
  });

  it('fasst einen von Hand geänderten Block nicht an', () => {
    const mit = applyGlobalSettings(BASE, input(FULL));
    const hand = mit.replace('gt 300 }', 'gt 300 } || { src 10.0.0.1 }');
    expect(parseProtection(hand)).toBeNull();
    expect(parseGlobalSettings(hand).protection).toBeNull();
    // Ohne Feld bleibt er stehen, mit Feld wird abgelehnt.
    expect(applyGlobalSettings(hand, input(undefined))).toBe(hand);
    expect(() => applyGlobalSettings(hand, input(FULL))).toThrow(HaproxyConfigError);
  });

  it('nimmt die bind-Zeile des HTTPS-Frontends und nicht die einer TCP-Weiterleitung', () => {
    const mitStream = `${BASE}
frontend tcp_5432
    mode tcp
    bind :5432
    default_backend db
`;
    const next = applyGlobalSettings(mitStream, input(FULL));
    expect(section(next, 'public_https')).toContain(PROTECTION_MARKER);
  });

  it('kennt die Länder, deren Listen geladen werden', () => {
    expect(geoBlockCountries(applyGlobalSettings(BASE, input(FULL)))).toEqual(['CN', 'RU']);
    expect(geoBlockCountries(BASE)).toEqual([]);
  });
});

describe('validateProtection', () => {
  it('nimmt den Normalfall an', () => {
    expect(de(validateProtection(FULL))).toBeNull();
  });

  it('lehnt falsche Adressen, Länder und Zahlen ab', () => {
    expect(de(validateProtection({ ...FULL, blockedIps: ['10.0.0.300'] }))).toMatch(/Keine gültige Adresse/);
    expect(de(validateProtection({ ...FULL, blockedIps: ['10.0.0.1', '10.0.0.1'] }))).toMatch(/doppelt/);
    expect(de(validateProtection({ ...FULL, blockedCountries: ['DEU'] }))).toMatch(/Ländercode/);
    expect(de(validateProtection({ ...FULL, blockedCountries: ['ZZ'] }))).toMatch(/Ländercode/);
    expect(de(validateProtection({ ...FULL, rateLimit: { requests: 5, period: '10s' } }))).toMatch(/ganze Zahl/);
    expect(de(validateProtection({ ...FULL, rateLimit: { requests: 1.5, period: '10s' } }))).toMatch(/ganze Zahl/);
    expect(
      de(validateProtection({ ...FULL, rateLimit: { requests: 100, period: '5h' as '10s' } }))
    ).toMatch(/Zeitraum/);
  });
});

/** Eine kleine Tabelle: 10.0.0.0/8 und 2001:db8::/32 sind DE, ab 11.0.0.0 FR. */
const TABLE: GeoTable = {
  version: '2026-11',
  source: 'Test',
  builtAt: '2026-11-25T00:00:00.000Z',
  countries: ['ZZ', 'DE', 'FR'],
  starts4: new Uint32Array([0, 0x0a000000, 0x0b000000]),
  codes4: new Uint8Array([0, 1, 2]),
  starts6: new BigUint64Array([0n, 0x20010db800000000n, 0x20010db900000000n]),
  codes6: new Uint8Array([0, 1, 0]),
};

describe('Länderlisten aus der GeoIP-Tabelle', () => {
  it('macht aus Bereichen die wenigsten Netze', () => {
    expect(countryNetworks(TABLE, 'DE')).toEqual(['10.0.0.0/8', '2001:db8:0:0::/32']);
    expect(countryNetworks(TABLE, 'FR')).toEqual([
      '11.0.0.0/8',
      '12.0.0.0/6',
      '16.0.0.0/4',
      '32.0.0.0/3',
      '64.0.0.0/2',
      '128.0.0.0/1',
    ]);
    expect(countryNetworks(TABLE, 'US')).toEqual([]);
    expect(countryNetworks(TABLE, 'ZZ')).toEqual([]);
  });

  it('schreibt eine Datei mit Kommentarkopf', () => {
    const content = geoBlockFileContent(TABLE, 'DE');
    expect(content.split('\n').filter((l) => l && !l.startsWith('#'))).toEqual([
      '10.0.0.0/8',
      '2001:db8:0:0::/32',
    ]);
  });

  it('nennt nur echte Länder', () => {
    expect(knownCountries(TABLE)).toEqual(['DE', 'FR']);
  });

  it('erkennt Adressen in Netzen', () => {
    expect(addressInNetwork('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(addressInNetwork('11.0.0.1', '10.0.0.0/8')).toBe(false);
    expect(addressInNetwork('203.0.113.7', '203.0.113.7')).toBe(true);
    expect(addressInNetwork('::ffff:10.0.0.1', '10.0.0.0/8')).toBe(true);
    expect(addressInNetwork('2001:db8::1', '2001:db8::/32')).toBe(true);
    expect(addressInNetwork('2001:db9::1', '2001:db8::/32')).toBe(false);
    expect(addressInNetwork('10.0.0.1', '2001:db8::/32')).toBe(false);
    expect(addressInNetwork('unknown', '10.0.0.0/8')).toBe(false);
  });
});

describe('lockoutReason', () => {
  it('lehnt eine Sperre auf die eigene Adresse ab, auch für Admin-IPs', () => {
    expect(de(lockoutReason(FULL, ['198.51.100.9'], { ip: '198.51.100.9', country: 'DE' }))).toMatch(
      /198\.51\.100\.0\/24/
    );
  });

  it('lehnt das eigene Land ab, außer die Adresse ist Admin-IP', () => {
    expect(de(lockoutReason(FULL, [], { ip: '192.0.2.1', country: 'RU' }))).toMatch(/RU/);
    expect(lockoutReason(FULL, ['192.0.2.0/24'], { ip: '192.0.2.1', country: 'RU' })).toBeNull();
  });

  it('sagt nichts, wenn die Adresse unbekannt ist', () => {
    expect(lockoutReason(FULL, [], { ip: 'unknown', country: null })).toBeNull();
  });
});
