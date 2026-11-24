import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hetzner } from '@/lib/dns/hetzner';
import { encodeRecordId, type HetznerRRSet } from '@/lib/dns/hetzner-rrsets';
import type { DnsRecord } from '@/lib/dns/records';

/**
 * Der Zugang zu Hetzner, ohne Netz: `fetch` ist untergeschoben, führt Buch und
 * antwortet in der Form, die die Referenz der Hetzner Cloud API beschreibt
 * (Abschnitte „Zones", „Zone RRSets" und „Actions").
 *
 * Geprüft wird, was an der Abbildung hängt: welche Aufrufe für eine Änderung
 * hinausgehen, in welcher Reihenfolge, und dass der Nachbar im selben Satz in
 * keinem davon vorkommt.
 */

const ZONE = { id: '42', name: 'example.org' };
const BASE = 'https://api.hetzner.cloud/v1';

interface Call {
  method: string;
  path: string;
  body: unknown;
  authorization: string | null;
}

type Answer = { status?: number; body: unknown };
type Handler = (call: Call) => Answer | undefined;

let calls: Call[];
let handlers: Handler[];

function answer(handler: Handler): void {
  handlers.push(handler);
}

/** Die Antwort auf einen schreibenden Aufruf: eine Aktion, hier schon fertig. */
function done(id = 1): Answer {
  return { status: 201, body: { action: { id, status: 'success', error: null } } };
}

function rrsetAt(rrset: HetznerRRSet): Handler {
  return (call) =>
    call.method === 'GET' && call.path === `/zones/42/rrsets/${encodeURIComponent(rrset.name)}/${rrset.type}`
      ? { body: { rrset } }
      : undefined;
}

function current(name: string, type: string, value: string, patch: Partial<DnsRecord> = {}): DnsRecord {
  return {
    id: encodeRecordId({ name, type, value }),
    type,
    name: name === '@' ? ZONE.name : `${name}.${ZONE.name}`,
    content: value,
    ttl: 3600,
    proxied: false,
    priority: null,
    comment: null,
    locked: false,
    ...patch,
  };
}

function written(): [string, string, unknown][] {
  return calls.filter((call) => call.method !== 'GET').map((call) => [call.method, call.path, call.body]);
}

beforeEach(() => {
  calls = [];
  handlers = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      const headers = new Headers(init.headers);
      const call: Call = {
        method: init.method ?? 'GET',
        path: url.startsWith(BASE) ? url.slice(BASE.length) : url,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        authorization: headers.get('authorization'),
      };
      calls.push(call);
      for (const handler of handlers) {
        const found = handler(call);
        if (found) {
          return new Response(JSON.stringify(found.body), {
            status: found.status ?? 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
      return new Response(
        JSON.stringify({ error: { code: 'not_found', message: 'rrset not found' } }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('listZones', () => {
  it('liest alle Seiten und schickt den Token nur im Kopf', async () => {
    answer((call) => {
      if (!call.path.startsWith('/zones?')) return undefined;
      const page = new URL(`${BASE}${call.path}`).searchParams.get('page');
      return page === '1'
        ? {
            body: {
              zones: [
                { id: 42, name: 'example.org', authoritative_nameservers: { delegation_status: 'valid' } },
              ],
              meta: { pagination: { page: 1, next_page: 2 } },
            },
          }
        : {
            body: {
              zones: [
                { id: 43, name: 'example.net', authoritative_nameservers: { delegation_status: 'lame' } },
                { id: 44, name: 'example.com', authoritative_nameservers: { delegation_status: 'unknown' } },
              ],
              meta: { pagination: { page: 2, next_page: null } },
            },
          };
    });

    const zones = await hetzner.listZones('geheim');

    expect(zones).toEqual([
      { id: '42', name: 'example.org', delegated: true },
      { id: '43', name: 'example.net', delegated: false },
      // Noch nicht geprüft heißt unbekannt, nicht „zeigt woandershin".
      { id: '44', name: 'example.com', delegated: null },
    ]);
    expect(calls.map((call) => call.path)).toEqual(['/zones?per_page=50&page=1', '/zones?per_page=50&page=2']);
    expect(calls.every((call) => call.authorization === 'Bearer geheim')).toBe(true);
    expect(calls.some((call) => call.path.includes('geheim'))).toBe(false);
  });

  it('sagt bei einem abgelehnten Token, woran es liegt', async () => {
    answer(() => ({
      status: 401,
      body: { error: { code: 'unauthorized', message: 'unable to authenticate', details: null } },
    }));
    await expect(hetzner.listZones('falsch')).rejects.toThrow(/Hetzner hat den API-Token abgelehnt/);
  });

  it('nennt ein Token ohne Schreibrecht beim Namen', async () => {
    answer(() => ({ status: 403, body: { error: { code: 'forbidden', message: 'insufficient permissions' } } }));
    await expect(hetzner.listZones('nur-lesen')).rejects.toThrow(/Lese- und Schreibrecht/);
  });
});

describe('listRecords', () => {
  it('blättert durch die Sätze und zeigt jeden Wert einzeln', async () => {
    answer((call) => {
      if (!call.path.startsWith('/zones/42/rrsets?')) return undefined;
      const page = new URL(`${BASE}${call.path}`).searchParams.get('page');
      return page === '1'
        ? {
            body: {
              rrsets: [
                {
                  id: 'www/A',
                  name: 'www',
                  type: 'A',
                  ttl: null,
                  protection: { change: false },
                  records: [{ value: '203.0.113.10' }, { value: '203.0.113.11' }],
                },
              ],
              meta: { pagination: { next_page: 2 } },
            },
          }
        : {
            body: {
              rrsets: [
                {
                  id: '@/MX',
                  name: '@',
                  type: 'MX',
                  ttl: 3600,
                  protection: { change: false },
                  records: [{ value: '10 mail.example.org.', comment: 'Post' }],
                },
              ],
              meta: { pagination: { next_page: null } },
            },
          };
    });

    const records = await hetzner.listRecords('t', ZONE);

    expect(records.map((r) => [r.type, r.name, r.content, r.priority, r.ttl, r.comment])).toEqual([
      ['A', 'www.example.org', '203.0.113.10', null, null, null],
      ['A', 'www.example.org', '203.0.113.11', null, null, null],
      ['MX', 'example.org', 'mail.example.org', 10, 3600, 'Post'],
    ]);
    expect(calls).toHaveLength(2);
  });

  it('erklärt eine Sekundärzone, statt den Fehlercode durchzureichen', async () => {
    answer(() => ({
      status: 422,
      body: { error: { code: 'incorrect_zone_mode', message: 'operation not supported' } },
    }));
    await expect(hetzner.listRecords('t', ZONE)).rejects.toThrow(/Sekundärzone/);
  });
});

describe('createRecord', () => {
  it('fügt einem bestehenden Satz einen Wert hinzu und fasst die anderen nicht an', async () => {
    answer(
      rrsetAt({ name: 'www', type: 'A', ttl: 3600, records: [{ value: '203.0.113.10' }] })
    );
    answer((call) => (call.method === 'POST' ? done() : undefined));

    const record = await hetzner.createRecord('t', ZONE, {
      type: 'A',
      name: 'www.example.org',
      content: '203.0.113.11',
      ttl: null,
    });

    expect(written()).toEqual([
      [
        'POST',
        '/zones/42/rrsets/www/A/actions/add_records',
        { ttl: 3600, records: [{ value: '203.0.113.11' }] },
      ],
    ]);
    // Die TTL ist die des Satzes: „keine eigene" beim Anlegen ändert sie nicht.
    expect(record).toMatchObject({ name: 'www.example.org', content: '203.0.113.11', ttl: 3600 });
  });

  it('legt den CNAME eines Proxy-Ziels auf die Zone mit Punkt am Ende an', async () => {
    answer((call) => (call.method === 'POST' ? done() : undefined));

    await hetzner.createRecord('t', ZONE, {
      type: 'CNAME',
      name: 'app.example.org',
      content: 'example.org',
      ttl: null,
      comment: 'HAPM',
    });

    expect(written()).toEqual([
      [
        'POST',
        '/zones/42/rrsets/app/CNAME/actions/add_records',
        { records: [{ value: 'example.org.', comment: 'HAPM' }] },
      ],
    ]);
  });

  it('schreibt die Zone selbst als `@` und einen TXT-Wert in Anführungszeichen', async () => {
    answer((call) => (call.method === 'POST' ? done() : undefined));

    await hetzner.createRecord('t', ZONE, {
      type: 'TXT',
      name: 'example.org',
      content: 'v=spf1 -all',
      ttl: 300,
    });

    expect(written()).toEqual([
      [
        'POST',
        '/zones/42/rrsets/%40/TXT/actions/add_records',
        { ttl: 300, records: [{ value: '"v=spf1 -all"' }] },
      ],
    ]);
  });

  it('legt keinen Wert an, der schon dasteht', async () => {
    answer(
      rrsetAt({ name: 'www', type: 'A', ttl: 3600, records: [{ value: '203.0.113.10' }] })
    );
    await expect(
      hetzner.createRecord('t', ZONE, { type: 'A', name: 'www.example.org', content: '203.0.113.10', ttl: null })
    ).rejects.toThrow(/steht dort bereits/);
    expect(written()).toEqual([]);
  });

  it('wartet, bis Hetzner die Änderung ausgeführt hat', async () => {
    vi.useFakeTimers();
    let asked = 0;
    answer((call) =>
      call.method === 'POST' ? { status: 201, body: { action: { id: 7, status: 'running' } } } : undefined
    );
    answer((call) => {
      if (call.path !== '/actions/7') return undefined;
      asked += 1;
      return { body: { action: { id: 7, status: asked < 2 ? 'running' : 'success' } } };
    });

    let finished = false;
    const pending = hetzner
      .createRecord('t', ZONE, { type: 'A', name: 'neu.example.org', content: '203.0.113.10', ttl: null })
      .then(() => {
        finished = true;
      });

    await vi.advanceTimersByTimeAsync(200);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    await pending;

    expect(asked).toBe(2);
  });

  it('meldet eine Änderung, die Hetzner annimmt und dann nicht ausführt', async () => {
    answer((call) =>
      call.method === 'POST'
        ? {
            status: 201,
            body: {
              action: { id: 7, status: 'error', error: { code: 'action_failed', message: 'record is invalid' } },
            },
          }
        : undefined
    );
    await expect(
      hetzner.createRecord('t', ZONE, { type: 'A', name: 'neu.example.org', content: '203.0.113.10', ttl: null })
    ).rejects.toThrow(/nicht ausgeführt: record is invalid/);
  });

  it('versucht es noch einmal, wenn an der Zone gerade eine andere Änderung läuft', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    answer((call) => {
      if (call.method !== 'POST') return undefined;
      attempts += 1;
      return attempts === 1
        ? { status: 423, body: { error: { code: 'locked', message: 'zone is locked' } } }
        : done();
    });

    const pending = hetzner.createRecord('t', ZONE, {
      type: 'A',
      name: 'neu.example.org',
      content: '203.0.113.10',
      ttl: null,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await pending;

    expect(attempts).toBe(2);
  });
});

describe('updateRecord', () => {
  const set: HetznerRRSet = {
    name: 'www',
    type: 'A',
    ttl: 3600,
    records: [{ value: '203.0.113.10' }, { value: '203.0.113.11' }],
  };

  it('tauscht einen Wert: erst der neue, dann der alte, der Nachbar kommt nicht vor', async () => {
    answer(rrsetAt(set));
    answer((call) => (call.method === 'POST' ? done() : undefined));

    await hetzner.updateRecord('t', ZONE, current('www', 'A', '203.0.113.10'), {
      type: 'A',
      name: 'www.example.org',
      content: '203.0.113.12',
      ttl: 3600,
    });

    expect(written()).toEqual([
      [
        'POST',
        '/zones/42/rrsets/www/A/actions/add_records',
        { ttl: 3600, records: [{ value: '203.0.113.12' }] },
      ],
      ['POST', '/zones/42/rrsets/www/A/actions/remove_records', { records: [{ value: '203.0.113.10' }] }],
    ]);
    expect(JSON.stringify(written())).not.toContain('203.0.113.11');
  });

  it('liest den Satz vor dem Schreiben und merkt, wenn der Wert nicht mehr dasteht', async () => {
    answer(rrsetAt({ ...set, records: [{ value: '203.0.113.11' }] }));

    await expect(
      hetzner.updateRecord('t', ZONE, current('www', 'A', '203.0.113.10'), {
        type: 'A',
        name: 'www.example.org',
        content: '203.0.113.12',
        ttl: 3600,
      })
    ).rejects.toThrow(/gibt es in der Zone nicht/);
    expect(written()).toEqual([]);
  });

  it('sagt dazu, wenn der zweite Schritt scheitert und der erste schon steht', async () => {
    answer(rrsetAt(set));
    answer((call) => (call.path.endsWith('/add_records') ? done() : undefined));
    answer((call) =>
      call.path.endsWith('/remove_records')
        ? { status: 422, body: { error: { code: 'invalid_input', message: 'invalid input' } } }
        : undefined
    );

    await expect(
      hetzner.updateRecord('t', ZONE, current('www', 'A', '203.0.113.10'), {
        type: 'A',
        name: 'www.example.org',
        content: '203.0.113.12',
        ttl: 3600,
      })
    ).rejects.toThrow(/Hetzner: invalid input.*bereits ausgeführt/);
  });

  it('weist eine Kennung ab, die nicht von hier stammt', async () => {
    await expect(
      hetzner.updateRecord('t', ZONE, { ...current('www', 'A', '203.0.113.10'), id: 'fremd' }, {
        type: 'A',
        name: 'www.example.org',
        content: '203.0.113.12',
        ttl: 3600,
      })
    ).rejects.toThrow(/gibt es in der Zone nicht/);
    expect(calls).toEqual([]);
  });
});

describe('deleteRecord', () => {
  it('entfernt den einen Wert mit dem Wortlaut, den Hetzner führt', async () => {
    answer((call) => (call.method === 'POST' ? done() : undefined));

    // Die Anzeige zeigt `mail.example.org` und die Priorität daneben. Entfernt
    // wird, was in der Kennung steht.
    await hetzner.deleteRecord(
      't',
      ZONE,
      current('@', 'MX', '10 mail.example.org.', { content: 'mail.example.org', priority: 10 })
    );

    expect(written()).toEqual([
      ['POST', '/zones/42/rrsets/%40/MX/actions/remove_records', { records: [{ value: '10 mail.example.org.' }] }],
    ]);
  });
});
