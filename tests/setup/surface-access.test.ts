import { describe, it, expect } from 'vitest';
import {
  executionPlan,
  hapmServiceInput,
  hasPublicIpv4,
  isPublicAddress,
  normalizeSurfaceIps,
  orderRecordAddresses,
  surfaceRestricted,
  validateSurfaceIps,
} from '@/lib/setup/rules';
import { validateCreateInput } from '@/lib/haproxy/config';
import { readPublicAddress } from '@/lib/setup/public-address';
import { germanText } from '@/lib/i18n';

/**
 * Zwei Dinge im Schritt „Adresse" einer Installation aus dem Internet:
 *
 * - der DNS-Eintrag schlägt die öffentliche Adresse vor, nicht die interne, die
 *   ein Server hinter einer Adressumsetzung an seiner Schnittstelle trägt,
 * - die Oberfläche lässt sich auf Adressen und Netze beschränken (Admin-IPs
 *   und ein gesperrtes Ziel).
 */

describe('öffentliche und private Adressen', () => {
  it('erkennt, was aus dem Internet erreichbar sein kann', () => {
    for (const address of ['203.0.113.7', '8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.0.1', '2001:db8::5', '2a01:4f8::1']) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });

  it('und was nicht: privat, eigener Rechner, link-lokal, geteilte Adressen', () => {
    for (const address of [
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.10',
      '127.0.0.1',
      '169.254.10.1',
      '100.64.0.1',
      '100.127.255.254',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fd00::1',
      'fc00::1',
      'fe80::1',
      '::ffff:10.0.0.5',
      '',
      'hapm.example.org',
      '999.1.1.1',
      '1.2.3',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });
});

describe('die Vorschläge für den DNS-Eintrag', () => {
  it('öffentlich: die öffentliche Adresse der Schnittstelle zuerst', () => {
    expect(orderRecordAddresses(['10.0.0.5', '203.0.113.7', 'fd00::1'], 'public', null)).toEqual([
      '203.0.113.7',
      '10.0.0.5',
      'fd00::1',
    ]);
  });

  it('öffentlich hinter einer Adressumsetzung: die von außen gesehene zuerst', () => {
    expect(orderRecordAddresses(['10.0.0.5'], 'public', '203.0.113.7')).toEqual(['203.0.113.7', '10.0.0.5']);
    // Dieselbe Adresse steht nicht zweimal da.
    expect(orderRecordAddresses(['203.0.113.7'], 'public', '203.0.113.7')).toEqual(['203.0.113.7']);
  });

  it('IPv4 vor IPv6: privates IPv4 und öffentliches IPv6 an der Schnittstelle', () => {
    expect(hasPublicIpv4(['10.0.0.5', '2001:db8::5'])).toBe(false);
    expect(hasPublicIpv4(['203.0.113.7', '2001:db8::5'])).toBe(true);
    expect(orderRecordAddresses(['10.0.0.5', '2001:db8::5'], 'public', '203.0.113.7')).toEqual([
      '203.0.113.7',
      '2001:db8::5',
      '10.0.0.5',
    ]);
    expect(orderRecordAddresses(['2001:db8::5', '203.0.113.7'], 'public', null)).toEqual(['203.0.113.7', '2001:db8::5']);
  });

  it('öffentlich ohne Auskunft von außen: es bleibt, was der Server weiß', () => {
    expect(orderRecordAddresses(['10.0.0.5'], 'public', null)).toEqual(['10.0.0.5']);
  });

  it('intern: die Reihenfolge der Schnittstellen, nach außen wird nicht gesehen', () => {
    expect(orderRecordAddresses(['10.0.0.5', '203.0.113.7'], 'internal', '198.51.100.9')).toEqual(['10.0.0.5', '203.0.113.7']);
    expect(orderRecordAddresses(['10.0.0.5'], null, '198.51.100.9')).toEqual(['10.0.0.5']);
  });

  it('nimmt von einem Dienst nur eine öffentliche Adresse an, sonst nichts', () => {
    expect(readPublicAddress('203.0.113.7\n')).toBe('203.0.113.7');
    expect(readPublicAddress(' 2001:db8::5 ')).toBe('2001:db8::5');
    expect(readPublicAddress('10.0.0.5')).toBeNull();
    expect(readPublicAddress('<html>Fehler</html>')).toBeNull();
    expect(readPublicAddress('203.0.113.7 203.0.113.8')).toBeNull();
    expect(readPublicAddress('')).toBeNull();
  });
});

describe('die Oberfläche nur von bestimmten Adressen', () => {
  it('liest die Liste ohne Leerzeilen und ohne Doppelte', () => {
    expect(normalizeSurfaceIps([' 203.0.113.7 ', '', '10.0.0.0/8', '203.0.113.7'])).toEqual(['203.0.113.7', '10.0.0.0/8']);
    expect(normalizeSurfaceIps(undefined)).toEqual([]);
    expect(normalizeSurfaceIps('203.0.113.7')).toEqual([]);
  });

  it('nimmt Adressen und Netze, sonst nichts', () => {
    expect(validateSurfaceIps([])).toBeNull();
    expect(validateSurfaceIps(['203.0.113.7', '10.0.0.0/8', '2001:db8::/32'])).toBeNull();
    expect(germanText(validateSurfaceIps(['203.0.113.7', 'büro'])!)).toContain('Keine gültige Adresse: büro');
    expect(germanText(validateSurfaceIps(['203.0.113.7; deny all'])!)).toContain('Keine gültige Adresse');
    expect(validateSurfaceIps(Array.from({ length: 51 }, (_, i) => `203.0.113.${i}`))).not.toBeNull();
  });

  it('gilt nur für eine Installation aus dem Internet', () => {
    expect(surfaceRestricted({ exposure: 'public', surfaceIps: ['203.0.113.7'] })).toBe(true);
    expect(surfaceRestricted({ exposure: 'public', surfaceIps: [] })).toBe(false);
    expect(surfaceRestricted({ exposure: 'public' })).toBe(false);
    expect(surfaceRestricted({ exposure: 'internal', surfaceIps: ['203.0.113.7'] })).toBe(false);
  });

  it('trägt die Adressen ein, BEVOR das gesperrte Ziel entsteht', () => {
    const base = { domain: 'hapm.example.org', wildcard: false, wildcardBase: null };
    expect(executionPlan({ ...base, exposure: 'public', surfaceIps: ['203.0.113.7'] })).toEqual([
      'scope',
      'certificate',
      'access',
      'service',
      'publicUrl',
    ]);
    expect(executionPlan({ ...base, exposure: 'public', surfaceIps: [] })).not.toContain('access');
    expect(executionPlan({ ...base, exposure: 'internal', surfaceIps: ['203.0.113.7'] })).not.toContain('access');
  });

  it('sperrt das Ziel der Oberfläche auf die Admin-IPs, ohne Passwort', () => {
    const locked = hapmServiceInput('hapm.example.org', 7080, true);
    expect(validateCreateInput(locked)).toBeNull();
    expect(locked.lockedDomains).toEqual(['hapm.example.org']);
    expect(locked.passwordLock).toBeNull();
    expect(hapmServiceInput('hapm.example.org', 7080).lockedDomains).toEqual([]);
  });
});
