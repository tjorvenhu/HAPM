import { describe, it, expect } from 'vitest';
import {
  DNS_PROVIDER_IDS,
  dnsProviderForHook,
  hookForDnsProvider,
  isDnsProviderId,
  providerOf,
} from '@/lib/dns/zones';
import { DNS_PROVIDER_INFOS, dnsProviderInfo } from '@/lib/dns/provider-info';
import { PROVIDER_RULES, sameAddress } from '@/lib/dns/records';
import { findDnsProvider } from '@/lib/haproxy/dns-credentials';

/**
 * Was am Anbieter hängt und was nicht: die Zuordnung zu den acme.sh-Hooks, die
 * Zeilen aus der Zeit vor dem Feld `provider`, und die Regeln, in denen sich
 * Cloudflare und Hetzner unterscheiden.
 */

describe('dnsProviderForHook', () => {
  it('ordnet jeden Hook seinem Anbieter zu und zurück', () => {
    expect(dnsProviderForHook('dns_cf')).toBe('cloudflare');
    expect(dnsProviderForHook('dns_hetznercloud')).toBe('hetzner');
    for (const id of DNS_PROVIDER_IDS) {
      expect(dnsProviderForHook(hookForDnsProvider(id))).toBe(id);
    }
  });

  it('gibt für alles andere null', () => {
    expect(dnsProviderForHook('dns_hetzner')).toBeNull();
    expect(dnsProviderForHook('dns_aws')).toBeNull();
    expect(dnsProviderForHook('')).toBeNull();
    // Der Name eines Objekt-Felds ist kein Hook.
    expect(dnsProviderForHook('toString')).toBeNull();
  });

  it('nennt nur Hooks, die die Zugangsdaten für acme.sh auch kennen', () => {
    for (const id of DNS_PROVIDER_IDS) {
      expect(findDnsProvider(hookForDnsProvider(id))).not.toBeNull();
    }
  });
});

describe('providerOf', () => {
  it('liest eine Zeile ohne das Feld als Cloudflare', () => {
    expect(providerOf({})).toBe('cloudflare');
    expect(providerOf({ provider: null })).toBe('cloudflare');
    expect(providerOf({ provider: undefined })).toBe('cloudflare');
  });

  it('nimmt, was dasteht', () => {
    expect(providerOf({ provider: 'hetzner' })).toBe('hetzner');
    expect(providerOf({ provider: 'cloudflare' })).toBe('cloudflare');
  });

  it('hält einen unbekannten Wert nicht für einen Anbieter', () => {
    expect(isDnsProviderId('route53')).toBe(false);
    expect(isDnsProviderId(undefined)).toBe(false);
    expect(providerOf({ provider: 'route53' })).toBe('cloudflare');
  });
});

describe('dnsProviderInfo', () => {
  it('nimmt Name, Zeichen und Konsole von der einen Stelle, die sie kennt', () => {
    for (const info of DNS_PROVIDER_INFOS) {
      const source = findDnsProvider(hookForDnsProvider(info.id));
      expect(info.label).toBe(source?.label);
      expect(info.consoleUrl).toBe(source?.consoleUrl);
      expect(info.logo).toMatch(/^\/providers\/[a-z]+\.svg$/);
      expect(info.tokenHint).toBeTruthy();
    }
    expect(dnsProviderInfo('hetzner').label).toBe('Hetzner');
    expect(dnsProviderInfo('cloudflare').label).toBe('Cloudflare');
  });
});

describe('Regeln je Anbieter', () => {
  it('kennt bei Hetzner die Vorgabe der Zone statt „automatisch“', () => {
    expect(PROVIDER_RULES.hetzner.defaultTtl).toBeNull();
    expect(PROVIDER_RULES.cloudflare.defaultTtl).toBe(1);
  });

  it('kennt den Proxy nur bei Cloudflare', () => {
    expect(PROVIDER_RULES.cloudflare.proxy).toBe(true);
    expect(PROVIDER_RULES.hetzner.proxy).toBe(false);
  });
});

describe('sameAddress', () => {
  it('vergleicht IPv4 wörtlich', () => {
    expect(sameAddress('203.0.113.10', ' 203.0.113.10 ')).toBe(true);
    expect(sameAddress('203.0.113.10', '203.0.113.11')).toBe(false);
  });

  it('erkennt dieselbe IPv6-Adresse in jeder Schreibweise', () => {
    expect(sameAddress('2001:db8::1', '2001:0DB8:0000:0000:0000:0000:0000:0001')).toBe(true);
    expect(sameAddress('::1', '0:0:0:0:0:0:0:1')).toBe(true);
    expect(sameAddress('2001:db8::1', '2001:db8::2')).toBe(false);
    expect(sameAddress('::ffff:192.0.2.1', '::ffff:c000:201')).toBe(true);
  });

  it('hält zwei Werte, die keine Adressen sind, nicht für gleich', () => {
    expect(sameAddress('kaputt', 'auch:kaputt:::')).toBe(false);
  });
});
