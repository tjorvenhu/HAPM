import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DnsProvider, ProviderZone, RecordWrite, ZoneRef } from '@/lib/dns/provider';
import type { DnsRecord } from '@/lib/dns/records';
import type { DnsProviderId } from '@/lib/dns/zones';

/**
 * Eine Zone einrichten und einen Adress-Eintrag sicherstellen, ohne Netz und
 * ohne Datenbank: die Fassade liegt im Speicher (`fake-db.ts`), und hinter
 * `providerFor` steht ein nachgestellter Anbieter, der Buch führt.
 *
 * Nachgestellt ist die Schnittstelle (`lib/dns/provider.ts`) und nicht die API
 * eines Anbieters: genau das, was `connect.ts` von ihm sieht.
 */

vi.mock('@/lib/db', async () => await import('./fake-db'));

vi.mock('@/lib/crypto', () => ({
  encrypt: (plaintext: string) => `enc:${plaintext}`,
  decrypt: (ciphertext: string) => {
    if (!ciphertext.startsWith('enc:')) throw new Error('Ungültiges Chiffrat');
    return ciphertext.slice(4);
  },
}));

interface FakeProvider extends DnsProvider {
  /** Token → die Zonen, die er sieht. Ein Token, der fehlt, wird abgelehnt. */
  tokens: Map<string, ProviderZone[]>;
  /** Kennung der Zone → ihr Bestand. */
  records: Map<string, DnsRecord[]>;
  calls: string[];
  /** Die Domain, die `listZones` mitbekam, je Aufruf. */
  nears: (string | undefined)[];
  /** Die Namen, die `listRecords` mitbekam, je Aufruf. */
  names: (readonly string[] | undefined)[];
  /** Nur gesetzt, wo der Anbieter Lesen und Ändern unterscheidet. `false`: er lehnt ab. */
  writable?: boolean;
}

function fakeProvider(id: DnsProviderId): FakeProvider {
  let counter = 0;
  const fake: FakeProvider = {
    id,
    tokens: new Map(),
    records: new Map(),
    calls: [],
    nears: [],
    names: [],
    async listZones(token, near) {
      fake.calls.push('listZones');
      fake.nears.push(near);
      const zones = fake.tokens.get(token);
      if (!zones) throw new Error('Der API-Token wurde abgelehnt.');
      return zones;
    },
    async listRecords(_token: string, zone: ZoneRef, names) {
      fake.calls.push('listRecords');
      fake.names.push(names);
      return [...(fake.records.get(zone.id) ?? [])];
    },
    async createRecord(_token: string, zone: ZoneRef, input: RecordWrite) {
      fake.calls.push(`create ${input.type} ${input.name} ${input.content}`);
      const record: DnsRecord = {
        id: `${id}-${(counter += 1)}`,
        type: input.type,
        name: input.name,
        content: input.content,
        ttl: input.ttl,
        proxied: input.proxied ?? false,
        priority: input.priority ?? null,
        comment: input.comment ?? null,
        locked: false,
      };
      fake.records.set(zone.id, [...(fake.records.get(zone.id) ?? []), record]);
      return record;
    },
    async updateRecord(_token: string, zone: ZoneRef, current: DnsRecord, input: RecordWrite) {
      fake.calls.push(`update ${current.content} -> ${input.content}`);
      const next: DnsRecord = {
        ...current,
        type: input.type,
        name: input.name,
        content: input.content,
        ttl: input.ttl,
        proxied: input.proxied ?? false,
        comment: input.comment ?? null,
      };
      fake.records.set(
        zone.id,
        (fake.records.get(zone.id) ?? []).map((record) => (record.id === current.id ? next : record))
      );
      return next;
    },
    async deleteRecord(_token: string, zone: ZoneRef, current: DnsRecord) {
      fake.calls.push(`delete ${current.type} ${current.content}`);
      fake.records.set(
        zone.id,
        (fake.records.get(zone.id) ?? []).filter((record) => record.id !== current.id)
      );
    },
  };
  // Wie ein Nameserver über RFC 2136: ein gültiger Schlüssel darf nicht unbedingt ändern.
  if (id === 'rfc2136') {
    fake.writable = true;
    fake.assertWritable = async () => {
      fake.calls.push('assertWritable');
      if (!fake.writable) throw new Error('Der Schlüssel darf die Zone nicht ändern.');
    };
  }
  return fake;
}

let providers: Record<DnsProviderId, FakeProvider>;

vi.mock('@/lib/dns/provider', () => ({
  providerFor: (zone: DnsProviderId | { provider?: string | null }) => {
    const named = typeof zone === 'string' ? zone : zone.provider;
    // Eine Zeile ohne das Feld ist Cloudflare (`providerOf`).
    const id = named && named in providers ? (named as DnsProviderId) : 'cloudflare';
    return providers[id];
  },
}));

import { createDocument, resetFakeDb, rowsOf } from './fake-db';
import { connectZone, dnsProviderForHook, ensureAddressRecord, replaceZoneToken } from '@/lib/dns/connect';

const ZONES = 'dns_zones';

function seen(id: string, name: string, delegated: boolean | null = true): ProviderZone {
  return { id, name, delegated };
}

function record(patch: Partial<DnsRecord>): DnsRecord {
  return {
    id: `r-${Math.random()}`,
    type: 'A',
    name: 'hapm.example.org',
    content: '203.0.113.10',
    ttl: null,
    proxied: false,
    priority: null,
    comment: null,
    locked: false,
    ...patch,
  };
}

/** Eine eingerichtete Zone samt Bestand beim nachgestellten Anbieter. */
async function zoneWith(provider: DnsProviderId | undefined, records: DnsRecord[]): Promise<string> {
  const row = await createDocument(ZONES, {
    ...(provider ? { provider } : {}),
    name: 'example.org',
    zoneId: 'zone-1',
    apiToken: 'enc:token',
    status: 'ok',
    lastCheckedAt: null,
    lastError: null,
  });
  providers[provider ?? 'cloudflare'].records.set('zone-1', records);
  return String(row.$id);
}

beforeEach(() => {
  resetFakeDb();
  providers = {
    cloudflare: fakeProvider('cloudflare'),
    hetzner: fakeProvider('hetzner'),
    rfc2136: fakeProvider('rfc2136'),
    infoblox: fakeProvider('infoblox'),
  };
});

describe('dnsProviderForHook', () => {
  it('ordnet die acme.sh-Hooks ihrem Anbieter zu', () => {
    expect(dnsProviderForHook('dns_cf')).toBe('cloudflare');
    expect(dnsProviderForHook('dns_hetznercloud')).toBe('hetzner');
    expect(dnsProviderForHook('dns_nsupdate')).toBe('rfc2136');
    expect(dnsProviderForHook('dns_infoblox')).toBe('infoblox');
  });

  it('kennt keinen anderen, auch nicht den früheren Hetzner-Hook', () => {
    expect(dnsProviderForHook('dns_hetzner')).toBeNull();
    expect(dnsProviderForHook('')).toBeNull();
    expect(dnsProviderForHook('cloudflare')).toBeNull();
  });
});

describe('connectZone', () => {
  it('richtet die Zone ein, in der die Domain liegt, und legt den Token verschlüsselt ab', async () => {
    providers.hetzner.tokens.set('geheim', [seen('42', 'example.org'), seen('43', 'example.net')]);

    const result = await connectZone({ provider: 'hetzner', domain: 'hapm.example.org', token: ' geheim ' });

    expect(result.created).toBe(true);
    expect(result.delegated).toBe(true);
    expect(result.zone).toMatchObject({ provider: 'hetzner', name: 'example.org', zoneId: '42', status: 'ok' });
    // Der Token geht nicht an den Browser.
    expect(JSON.stringify(result.zone)).not.toContain('geheim');
    expect(rowsOf(ZONES)).toHaveLength(1);
    expect(rowsOf(ZONES)[0]).toMatchObject({ provider: 'hetzner', apiToken: 'enc:geheim' });
  });

  it('nimmt die längste Zone, die das Token sieht', async () => {
    providers.cloudflare.tokens.set('t', [seen('a', 'example.org'), seen('b', 'intern.example.org')]);
    const { zone } = await connectZone({ provider: 'cloudflare', domain: 'app.intern.example.org', token: 't' });
    expect(zone.name).toBe('intern.example.org');
    expect(zone.zoneId).toBe('b');
  });

  it('hält eine Zone, die den Namen nur enthält, nicht für die richtige', async () => {
    providers.cloudflare.tokens.set('t', [seen('a', 'kunde.example')]);
    await expect(
      connectZone({ provider: 'cloudflare', domain: 'app.fremdekunde.example', token: 't' })
    ).rejects.toThrow(/keine Zone für "app\.fremdekunde\.example"/);
  });

  it('nennt die Zonen, die das Token stattdessen sieht', async () => {
    providers.hetzner.tokens.set('t', [seen('1', 'example.net'), seen('2', 'example.com')]);
    await expect(connectZone({ provider: 'hetzner', domain: 'example.org', token: 't' })).rejects.toThrow(
      /Hetzner kennt unter diesem Token keine Zone.*Der Token sieht: example\.net, example\.com\./
    );
    expect(rowsOf(ZONES)).toHaveLength(0);
  });

  it('sagt es, wenn das Token gar keine Zone sieht', async () => {
    providers.cloudflare.tokens.set('t', []);
    await expect(connectZone({ provider: 'cloudflare', domain: 'example.org', token: 't' })).rejects.toThrow(
      /Cloudflare kennt.*überhaupt keine Zone/
    );
  });

  it('ersetzt den Zugang einer Zone, die schon dasteht, statt eine zweite Zeile anzulegen', async () => {
    providers.cloudflare.tokens.set('alt', [seen('cf-1', 'example.org')]);
    providers.hetzner.tokens.set('neu', [seen('99', 'example.org', false)]);

    const first = await connectZone({ provider: 'cloudflare', domain: 'example.org', token: 'alt' });
    const second = await connectZone({ provider: 'hetzner', domain: 'www.example.org', token: 'neu' });

    expect(second.created).toBe(false);
    expect(second.delegated).toBe(false);
    expect(second.zone.$id).toBe(first.zone.$id);
    expect(rowsOf(ZONES)).toHaveLength(1);
    expect(rowsOf(ZONES)[0]).toMatchObject({ provider: 'hetzner', zoneId: '99', apiToken: 'enc:neu' });
  });

  it('lässt den alten Zugang stehen, wenn der neue Token die Zone nicht zeigt', async () => {
    providers.cloudflare.tokens.set('alt', [seen('cf-1', 'example.org')]);
    providers.cloudflare.tokens.set('falsch', [seen('cf-2', 'example.net')]);
    await connectZone({ provider: 'cloudflare', domain: 'example.org', token: 'alt' });

    await expect(
      connectZone({ provider: 'cloudflare', domain: 'example.org', token: 'falsch' })
    ).rejects.toThrow(/keine Zone/);
    expect(rowsOf(ZONES)[0]).toMatchObject({ zoneId: 'cf-1', apiToken: 'enc:alt' });
  });

  it('verlangt Domain und Token, bevor es den Anbieter fragt', async () => {
    await expect(connectZone({ provider: 'hetzner', domain: ' ', token: 't' })).rejects.toThrow(/Domain/);
    await expect(connectZone({ provider: 'hetzner', domain: 'example.org', token: ' ' })).rejects.toThrow(
      /API-Token von Hetzner/
    );
    expect(providers.hetzner.calls).toEqual([]);
  });

  it('gibt einem Anbieter, der seine Zonen nicht aufzählt, die Domain mit', async () => {
    providers.rfc2136.tokens.set('zugang', [seen('ns1.example.org', 'example.org', null)]);

    const result = await connectZone({ provider: 'rfc2136', domain: 'App.Example.org', token: 'zugang' });

    expect(providers.rfc2136.nears).toEqual(['app.example.org']);
    expect(result.zone).toMatchObject({ provider: 'rfc2136', name: 'example.org', zoneId: 'ns1.example.org' });
    expect(result.delegated).toBeNull();
    expect(rowsOf(ZONES)[0]).toMatchObject({ provider: 'rfc2136', apiToken: 'enc:zugang' });
  });

  it('prüft beim Anbinden, ob der Zugang die Zone auch ändern darf, und speichert sonst nichts', async () => {
    providers.rfc2136.tokens.set('zugang', [seen('ns1.example.org', 'example.org', null)]);
    providers.rfc2136.writable = false;

    await expect(connectZone({ provider: 'rfc2136', domain: 'app.example.org', token: 'zugang' })).rejects.toThrow(
      /nicht ändern/
    );
    expect(providers.rfc2136.calls).toEqual(['listZones', 'assertWritable']);
    expect(rowsOf(ZONES)).toHaveLength(0);
  });

  it('nennt bei einem solchen Anbieter keine Zonen, die der Zugang stattdessen sähe', async () => {
    providers.infoblox.tokens.set('zugang', []);
    await expect(connectZone({ provider: 'infoblox', domain: 'app.fremd.example', token: 'zugang' })).rejects.toThrow(
      'Infoblox: Dort gibt es keine Zone, in der "app.fremd.example" liegt.'
    );
  });

  it('verlangt dort Zugangsdaten statt eines Tokens', async () => {
    await expect(connectZone({ provider: 'rfc2136', domain: 'example.org', token: '' })).rejects.toThrow(
      /Zugangsdaten für RFC 2136/
    );
  });
});

describe('replaceZoneToken', () => {
  it('verlangt genau diese Zone und nicht die nächste darüber', async () => {
    const row = await createDocument(ZONES, {
      provider: 'hetzner',
      name: 'intern.example.org',
      zoneId: '7',
      apiToken: 'enc:alt',
      status: 'error',
      lastCheckedAt: null,
      lastError: 'abgelaufen',
    });
    providers.hetzner.tokens.set('breit', [seen('1', 'example.org')]);
    providers.hetzner.tokens.set('richtig', [seen('1', 'example.org'), seen('8', 'intern.example.org')]);

    await expect(replaceZoneToken(String(row.$id), 'breit')).rejects.toThrow(/sieht die Zone "intern\.example\.org" nicht/);
    expect(rowsOf(ZONES)[0]).toMatchObject({ apiToken: 'enc:alt', zoneId: '7' });

    const updated = await replaceZoneToken(String(row.$id), 'richtig');
    expect(updated).toMatchObject({ zoneId: '8', status: 'ok', lastError: null });
    expect(rowsOf(ZONES)[0]).toMatchObject({ apiToken: 'enc:richtig' });
  });

  it('fragt bei einer Zeile ohne Anbieter Cloudflare', async () => {
    const row = await createDocument(ZONES, { name: 'example.org', zoneId: 'cf-1', apiToken: 'enc:alt' });
    providers.cloudflare.tokens.set('neu', [seen('cf-1', 'example.org')]);

    const updated = await replaceZoneToken(String(row.$id), 'neu');
    expect(updated.provider).toBe('cloudflare');
    expect(providers.cloudflare.calls).toEqual(['listZones']);
    expect(providers.hetzner.calls).toEqual([]);
  });

  it('fragt einen Anbieter, der nicht aufzählt, nach genau dieser Zone und prüft das Ändern', async () => {
    const row = await createDocument(ZONES, {
      provider: 'rfc2136',
      name: 'example.org',
      zoneId: 'ns1.example.org',
      apiToken: 'enc:alt',
      status: 'ok',
      lastCheckedAt: null,
      lastError: null,
    });
    providers.rfc2136.tokens.set('leer', []);
    providers.rfc2136.tokens.set('neu', [seen('ns2.example.org', 'example.org', null)]);

    await expect(replaceZoneToken(String(row.$id), 'leer')).rejects.toThrow(
      'RFC 2136: Mit diesen Zugangsdaten gibt es die Zone "example.org" dort nicht.'
    );
    expect(rowsOf(ZONES)[0]).toMatchObject({ apiToken: 'enc:alt' });

    const updated = await replaceZoneToken(String(row.$id), 'neu');
    expect(providers.rfc2136.nears).toEqual(['example.org', 'example.org']);
    expect(providers.rfc2136.calls).toEqual(['listZones', 'listZones', 'assertWritable']);
    expect(updated).toMatchObject({ zoneId: 'ns2.example.org' });
  });
});

describe('ensureAddressRecord', () => {
  it('sagt dem Anbieter, um welchen Namen es geht', async () => {
    const id = await zoneWith('rfc2136', []);
    await ensureAddressRecord(id, { name: 'HAPM.example.org', address: '203.0.113.10' });
    // Ein Nameserver über RFC 2136 liest nur, was unter den genannten Namen steht.
    expect(providers.rfc2136.names).toEqual([['hapm.example.org']]);
  });

  it('legt den Eintrag an, wenn unter dem Namen nichts steht', async () => {
    const id = await zoneWith('hetzner', []);

    const result = await ensureAddressRecord(id, { name: 'hapm.example.org', address: '203.0.113.10' });

    expect(result).toEqual({ outcome: 'created', type: 'A' });
    expect(providers.hetzner.records.get('zone-1')).toMatchObject([
      // Die Vorgabe der Zone und kein `proxied`: beides kennt Hetzner nicht anders.
      { type: 'A', name: 'hapm.example.org', content: '203.0.113.10', ttl: null, comment: 'HAPM' },
    ]);
  });

  it('nimmt für eine IPv6-Adresse einen AAAA-Eintrag', async () => {
    const id = await zoneWith('hetzner', []);
    expect(await ensureAddressRecord(id, { name: 'hapm.example.org', address: '2001:db8::1' })).toEqual({
      outcome: 'created',
      type: 'AAAA',
    });
  });

  it('legt bei Cloudflare ohne Proxy und mit automatischer TTL an', async () => {
    const id = await zoneWith('cloudflare', []);
    await ensureAddressRecord(id, { name: 'hapm.example.org', address: '203.0.113.10' });
    expect(providers.cloudflare.records.get('zone-1')).toMatchObject([{ proxied: false, ttl: 1 }]);
  });

  it('behandelt eine Zeile ohne Anbieter als Cloudflare', async () => {
    const id = await zoneWith(undefined, []);
    await ensureAddressRecord(id, { name: 'hapm.example.org', address: '203.0.113.10' });
    expect(providers.cloudflare.calls).toEqual(['listRecords', 'create A hapm.example.org 203.0.113.10']);
    expect(providers.hetzner.calls).toEqual([]);
  });

  it('lässt stehen, was schon stimmt', async () => {
    const id = await zoneWith('hetzner', [record({})]);
    expect(await ensureAddressRecord(id, { name: 'hapm.example.org', address: '203.0.113.10' })).toEqual({
      outcome: 'unchanged',
      type: 'A',
    });
    expect(providers.hetzner.calls).toEqual(['listRecords']);
  });

  it('erkennt dieselbe IPv6-Adresse in anderer Schreibweise', async () => {
    const id = await zoneWith('hetzner', [record({ type: 'AAAA', content: '2001:0db8:0:0:0:0:0:1' })]);
    expect(
      (await ensureAddressRecord(id, { name: 'hapm.example.org', address: '2001:db8::1' })).outcome
    ).toBe('unchanged');
  });

  it('ersetzt einen Eintrag derselben Art mit anderem Wert und behält dessen TTL', async () => {
    const id = await zoneWith('hetzner', [record({ content: '198.51.100.7', ttl: 300, comment: 'alt' })]);

    const result = await ensureAddressRecord(id, { name: 'hapm.example.org', address: '203.0.113.10' });

    expect(result).toEqual({ outcome: 'updated', type: 'A' });
    expect(providers.hetzner.records.get('zone-1')).toMatchObject([
      { content: '203.0.113.10', ttl: 300, comment: 'alt' },
    ]);
  });

  it('lässt von mehreren Einträgen der Art genau den richtigen übrig', async () => {
    const id = await zoneWith('hetzner', [
      record({ content: '198.51.100.7' }),
      record({ content: '203.0.113.10' }),
    ]);

    const result = await ensureAddressRecord(id, { name: 'hapm.example.org', address: '203.0.113.10' });

    expect(result.outcome).toBe('updated');
    expect(providers.hetzner.calls).toEqual(['listRecords', 'delete A 198.51.100.7']);
    expect(providers.hetzner.records.get('zone-1')).toMatchObject([{ content: '203.0.113.10' }]);
  });

  it('nimmt bei Cloudflare den Proxy von einem Eintrag, der sonst stimmt', async () => {
    const id = await zoneWith('cloudflare', [record({ proxied: true, ttl: 1 })]);
    expect((await ensureAddressRecord(id, { name: 'hapm.example.org', address: '203.0.113.10' })).outcome).toBe(
      'updated'
    );
    expect(providers.cloudflare.records.get('zone-1')).toMatchObject([{ proxied: false }]);
  });

  it('lässt die andere Adressfamilie und Einträge anderer Namen in Ruhe', async () => {
    const id = await zoneWith('hetzner', [
      record({ type: 'AAAA', content: '2001:db8::7' }),
      record({ type: 'TXT', content: 'v=spf1 -all' }),
      record({ name: 'www.example.org', content: '198.51.100.7' }),
    ]);

    await ensureAddressRecord(id, { name: 'hapm.example.org', address: '203.0.113.10' });

    expect(providers.hetzner.calls).toEqual(['listRecords', 'create A hapm.example.org 203.0.113.10']);
    expect(providers.hetzner.records.get('zone-1')).toHaveLength(4);
  });

  it('überschreibt keinen CNAME, sondern nennt ihn', async () => {
    const id = await zoneWith('hetzner', [record({ type: 'CNAME', content: 'example.org' })]);

    await expect(
      ensureAddressRecord(id, { name: 'hapm.example.org', address: '203.0.113.10' })
    ).rejects.toThrow(/CNAME-Eintrag auf example\.org.*nicht angefasst/);
    expect(providers.hetzner.calls).toEqual(['listRecords']);
    // Ein Eintrag im Weg ist eine Auskunft über den Namen, kein Fehler der Zone.
    expect(rowsOf(ZONES)[0]).toMatchObject({ status: 'ok', lastError: null });
  });

  it('fasst einen Eintrag nicht an, den der Anbieter gesperrt hat', async () => {
    const id = await zoneWith('hetzner', [record({ content: '198.51.100.7', locked: true })]);
    await expect(
      ensureAddressRecord(id, { name: 'hapm.example.org', address: '203.0.113.10' })
    ).rejects.toThrow(/nicht ändern lässt/);
    expect(providers.hetzner.calls).toEqual(['listRecords']);
  });

  it('setzt mit `@` den Eintrag der Zone selbst', async () => {
    const id = await zoneWith('hetzner', []);
    await ensureAddressRecord(id, { name: '@', address: '203.0.113.10' });
    expect(providers.hetzner.records.get('zone-1')).toMatchObject([{ name: 'example.org' }]);
  });

  it('weist ab, was keine Adresse ist oder nicht in der Zone liegt', async () => {
    const id = await zoneWith('hetzner', []);
    await expect(ensureAddressRecord(id, { name: 'hapm.example.org', address: 'example.net' })).rejects.toThrow(
      /IPv4- oder IPv6-Adresse/
    );
    await expect(ensureAddressRecord(id, { name: 'hapm.example.net', address: '203.0.113.10' })).rejects.toThrow(
      /liegt nicht in der Zone example\.org/
    );
    expect(providers.hetzner.calls).toEqual([]);
  });

  it('vermerkt an der Zone, wenn der Anbieter nicht antwortet', async () => {
    const id = await zoneWith('hetzner', []);
    providers.hetzner.listRecords = async () => {
      throw new Error('Hetzner ist nicht erreichbar.');
    };

    await expect(
      ensureAddressRecord(id, { name: 'hapm.example.org', address: '203.0.113.10' })
    ).rejects.toThrow(/nicht erreichbar/);
    expect(rowsOf(ZONES)[0]).toMatchObject({ status: 'error', lastError: 'Hetzner ist nicht erreichbar.' });
  });

  it('meldet eine Zone, die hier nicht eingerichtet ist', async () => {
    await expect(
      ensureAddressRecord('gibt-es-nicht', { name: 'hapm.example.org', address: '203.0.113.10' })
    ).rejects.toThrow(/nicht eingerichtet/);
  });
});
