import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { packAccess, type InfobloxAccess } from '@/lib/dns/access';
import { DnsUnreachableError } from '@/lib/dns/errors';
import { createInfoblox, httpsSend, type InfobloxProvider, type WapiRequest, type WapiResponse } from '@/lib/dns/infoblox';
import type { DnsRecord } from '@/lib/dns/records';

/**
 * Der Zugang zu Infoblox gegen eine nachgestellte Appliance: sie liest Pfad,
 * Abfrage und Rumpf wie die WAPI (Objekte je Eintragsart, `_ref` als Kennung,
 * Blättern über `_page_id`) und führt Buch.
 *
 * Gegen ein echtes Gerät lief das nie (docs/dns.md). Was hier feststeht, ist
 * die Form der Aufrufe, wie die WAPI-Dokumentation sie beschreibt, und was
 * HAPM aus den Antworten macht. Der letzte Abschnitt prüft die Verbindung
 * selbst gegen einen echten HTTPS-Server: dort entscheidet sich, ob einer
 * eigenen Zertifizierungsstelle vertraut wird.
 */

const ZONE = { id: 'infoblox.example.org/default', name: 'example.org' };

interface Stored {
  object: string;
  ref: string;
  fields: Record<string, unknown>;
}

class FakeAppliance {
  objects: Stored[] = [];
  calls: WapiRequest[] = [];
  user = 'hapm';
  password = 'geh3im!';
  /** So viele Objekte je Seite, um das Blättern zu erzwingen. */
  pageSize = 500;
  private counter = 0;
  /** Eine Folgeseite merkt sich, was gesucht war und welche Felder gewünscht sind, wie die WAPI. */
  private pages = new Map<string, { rest: Stored[]; fields: string }>();

  add(object: string, fields: Record<string, unknown>): Stored {
    this.counter += 1;
    const view = String(fields.view ?? 'default');
    const stored = { object, ref: `${object}/ZG5z${this.counter}:${String(fields.name ?? fields.fqdn)}/${view}`, fields: { view, ...fields } };
    this.objects.push(stored);
    return stored;
  }

  readonly send = async (request: WapiRequest): Promise<WapiResponse> => {
    this.calls.push(request);
    const expected = `Basic ${Buffer.from(`${this.user}:${this.password}`).toString('base64')}`;
    if (request.headers.Authorization !== expected) return { status: 401, body: '<html>401 Authorization Required</html>' };

    const url = new URL(`https://appliance${request.path}`);
    const target = decodeURIComponent(url.pathname.replace(/^\/wapi\/v[\d.]+\//, ''));
    const params = url.searchParams;
    const json = (status: number, body: unknown) => ({ status, body: JSON.stringify(body) });
    const pageId = params.get('_page_id');
    const fields = pageId ? (this.pages.get(pageId)?.fields ?? '') : (params.get('_return_fields') ?? '');
    const shape = (stored: Stored) => {
      const wanted = fields.split(',').filter(Boolean);
      return { _ref: stored.ref, ...Object.fromEntries(wanted.filter((field) => field in stored.fields).map((field) => [field, stored.fields[field]])) };
    };

    // Ein Objekt über seine Kennung.
    const byRef = this.objects.find((stored) => stored.ref === target);
    if (target.includes('/')) {
      if (!byRef) return json(404, { Error: 'AdmConDataNotFoundError', code: 'Client.Ibap.Data.NotFound', text: 'Reference not found' });
      if (request.method === 'GET') return json(200, shape(byRef));
      if (request.method === 'PUT') {
        Object.assign(byRef.fields, JSON.parse(request.body ?? '{}'));
        return json(200, byRef.ref);
      }
      if (request.method === 'DELETE') {
        this.objects = this.objects.filter((stored) => stored !== byRef);
        return json(200, byRef.ref);
      }
    }

    if (request.method === 'POST') {
      const body = JSON.parse(request.body ?? '{}') as Record<string, unknown>;
      const taken = this.objects.some((stored) => stored.fields.name === body.name && stored.fields.view === body.view);
      if (taken && target === 'record:cname') {
        return json(400, {
          Error: 'AdmConDataError: None (IBDataConflictError: IB.Data.Conflict)',
          code: 'Client.Ibap.Data.Conflict',
          text: `The record '${String(body.name)}' already exists.`,
        });
      }
      return json(201, this.add(target, body).ref);
    }

    // Eine Suche: gleiche Felder, wahlweise in Seiten.
    let found: Stored[];
    if (pageId) {
      found = this.pages.get(pageId)?.rest ?? [];
    } else {
      const filters = [...params.entries()].filter(([key]) => !key.startsWith('_'));
      found = this.objects.filter(
        (stored) => stored.object === target && filters.every(([key, value]) => String(stored.fields[key] ?? '') === value)
      );
    }
    if (params.get('_paging') !== '1' && !pageId) return json(200, found.map(shape));
    const page = found.slice(0, this.pageSize);
    const rest = found.slice(this.pageSize);
    const next = rest.length > 0 ? `seite-${this.pages.size + 1}` : undefined;
    if (next) this.pages.set(next, { rest, fields });
    return json(200, { result: page.map(shape), ...(next ? { next_page_id: next } : {}) });
  };
}

let appliance: FakeAppliance;
let provider: InfobloxProvider;

const access = (over: Partial<InfobloxAccess> = {}): string =>
  packAccess({
    server: 'infoblox.example.org',
    username: 'hapm',
    password: 'geh3im!',
    view: 'default',
    wapiVersion: '2.2.2',
    ca: null,
    ...over,
  });

const describeRecords = (records: DnsRecord[]) =>
  records.map((record) => `${record.type} ${record.content}${record.locked ? ' (gesperrt)' : ''}`).sort().join(' | ');

async function failure(work: () => Promise<unknown>): Promise<{ message: string; status: number }> {
  try {
    await work();
  } catch (err) {
    return { message: (err as Error).message, status: (err as { status?: number }).status ?? 0 };
  }
  throw new Error('Der Aufruf hätte scheitern müssen.');
}

beforeEach(() => {
  appliance = new FakeAppliance();
  appliance.add('view', { name: 'default' });
  appliance.add('view', { name: 'Intern' });
  appliance.add('zone_auth', { fqdn: 'example.org', zone_format: 'FORWARD' });
  appliance.add('zone_auth', { fqdn: 'intern.example.org', zone_format: 'FORWARD' });
  appliance.add('zone_auth', { fqdn: '2.0.192.in-addr.arpa', zone_format: 'IPV4' });
  appliance.add('zone_auth', { fqdn: 'example.org', zone_format: 'FORWARD', view: 'Intern' });
  appliance.add('record:a', { name: 'old.example.org', ipv4addr: '192.0.2.20', ttl: 120, use_ttl: true });
  appliance.add('record:cname', { name: 'alias.example.org', canonical: 'example.org', use_ttl: false, ttl: 28800, comment: 'HAPM' });
  appliance.add('record:host', { name: 'server.example.org', ipv4addrs: [{ ipv4addr: '192.0.2.30' }], ipv6addrs: [{ ipv6addr: '2001:db8::30' }] });
  provider = createInfoblox(appliance.send);
});

describe('Anmeldung und Adresse', () => {
  it('meldet sich mit Benutzer und Passwort an und spricht die genannte Fassung an', async () => {
    await provider.listZones(access(), 'example.org');
    const call = appliance.calls[0];
    expect(call.host).toBe('infoblox.example.org');
    expect(call.port).toBe(443);
    expect(call.path.startsWith('/wapi/v2.2.2/zone_auth?')).toBe(true);
    expect(call.headers.Authorization).toBe(`Basic ${Buffer.from('hapm:geh3im!').toString('base64')}`);
    // Die Zugangsdaten stehen in keiner URL.
    expect(call.path).not.toContain('geh3im');
  });

  it('nimmt einen eigenen Port und eine andere Fassung', async () => {
    await provider.listZones(access({ server: 'infoblox.example.org:8443', wapiVersion: '2.12' }), 'example.org');
    expect(appliance.calls[0]).toMatchObject({ host: 'infoblox.example.org', port: 8443 });
    expect(appliance.calls[0].path.startsWith('/wapi/v2.12/')).toBe(true);
  });

  it('reicht die eigene Zertifizierungsstelle an die Verbindung weiter', async () => {
    await provider.listZones(access({ ca: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n' }), 'example.org');
    expect(appliance.calls[0].ca).toContain('BEGIN CERTIFICATE');
    await provider.listZones(access(), 'example.org');
    expect(appliance.calls[appliance.calls.length - 1].ca).toBeNull();
  });

  it('sagt bei 401, dass die Anmeldung abgelehnt wurde', async () => {
    const rejected = await failure(() => provider.listZones(access({ password: 'falsch' }), 'example.org'));
    expect(rejected.message).toContain('hat die Anmeldung abgelehnt');
    // Kein 401 nach außen: das hielte die Oberfläche für eine abgelaufene Sitzung.
    expect(rejected.status).toBe(502);
  });

  it('lehnt einen gespeicherten Zugang ab, der keiner ist', async () => {
    expect((await failure(() => provider.listZones('kein-json', 'example.org'))).status).toBe(409);
  });
});

describe('listZones', () => {
  it('fragt gezielt nach der Domain und ihren Eltern, in der eigenen View', async () => {
    const zones = await provider.listZones(access(), 'app.sub.example.org');
    expect(zones).toEqual([{ id: 'infoblox.example.org/default', name: 'example.org', delegated: null }]);

    const asked = appliance.calls.map((call) => new URL(`https://x${call.path}`).searchParams);
    expect(asked.map((params) => params.get('fqdn'))).toEqual(['app.sub.example.org', 'sub.example.org', 'example.org']);
    expect(asked.every((params) => params.get('view') === 'default')).toBe(true);
  });

  it('liefert beide Zonen, wenn die Domain in einer engeren liegt', async () => {
    const zones = await provider.listZones(access(), 'app.intern.example.org');
    expect(zones.map((zone) => zone.name).sort()).toEqual(['example.org', 'intern.example.org']);
  });

  it('sagt, wenn es die View nicht gibt, statt „keine Zone"', async () => {
    const missing = await failure(() => provider.listZones(access({ view: 'gibt-es-nicht' }), 'app.example.org'));
    expect(missing.message).toContain('Die DNS-View "gibt-es-nicht" gibt es auf der Appliance nicht');
  });

  it('liefert nichts für eine Domain ohne Zone, wenn die View stimmt', async () => {
    expect(await provider.listZones(access(), 'app.fremd.example')).toEqual([]);
  });

  it('blättert ohne Domain durch alle Zonen und lässt Rückwärtszonen aus', async () => {
    appliance.pageSize = 1;
    const zones = await provider.listZones(access());
    expect(zones.map((zone) => zone.name).sort()).toEqual(['example.org', 'intern.example.org']);
    expect(appliance.calls.some((call) => call.path.includes('_page_id='))).toBe(true);
  });
});

describe('listRecords', () => {
  it('liest je Art unter dem Namen und kennt die Vorgabe der Zone als „keine eigene TTL"', async () => {
    const [old] = await provider.listRecords(access(), ZONE, ['old.example.org']);
    expect(old).toMatchObject({ type: 'A', name: 'old.example.org', content: '192.0.2.20', ttl: 120, locked: false });
    const [alias] = await provider.listRecords(access(), ZONE, ['alias.example.org']);
    expect(alias).toMatchObject({ type: 'CNAME', content: 'example.org', ttl: null, comment: 'HAPM' });
    expect(alias.id.startsWith('record:cname/')).toBe(true);
  });

  it('zeigt einen Host-Eintrag als gesperrte Adressen', async () => {
    expect(describeRecords(await provider.listRecords(access(), ZONE, ['server.example.org']))).toBe(
      'A 192.0.2.30 (gesperrt) | AAAA 2001:db8::30 (gesperrt)'
    );
  });

  it('liest ohne Namen die ganze Zone', async () => {
    appliance.objects.filter((stored) => stored.object.startsWith('record:')).forEach((stored) => (stored.fields.zone = 'example.org'));
    expect((await provider.listRecords(access(), ZONE)).length).toBe(4);
  });
});

describe('Schreiben', () => {
  it('legt einen CNAME in der View an und liest ihn über seine Kennung zurück', async () => {
    const created = await provider.createRecord(access(), ZONE, {
      type: 'CNAME',
      name: 'App.Example.org',
      content: 'example.org.',
      ttl: null,
      comment: 'HAPM',
    });
    expect(created).toMatchObject({ type: 'CNAME', name: 'app.example.org', content: 'example.org', ttl: null, comment: 'HAPM' });

    const post = appliance.calls.find((call) => call.method === 'POST')!;
    expect(post.path).toBe('/wapi/v2.2.2/record:cname');
    expect(JSON.parse(post.body!)).toEqual({ name: 'app.example.org', canonical: 'example.org', use_ttl: false, comment: 'HAPM', view: 'default' });
  });

  it('schreibt eine eigene TTL mit use_ttl', async () => {
    await provider.createRecord(access(), ZONE, { type: 'A', name: 'host.example.org', content: '192.0.2.50', ttl: 300 });
    const post = appliance.calls.find((call) => call.method === 'POST')!;
    expect(post.path).toBe('/wapi/v2.2.2/record:a');
    expect(JSON.parse(post.body!)).toMatchObject({ ipv4addr: '192.0.2.50', ttl: 300, use_ttl: true });
  });

  it('reicht die Absage der Appliance mit ihrem Satz weiter', async () => {
    const taken = await failure(() =>
      provider.createRecord(access(), ZONE, { type: 'CNAME', name: 'old.example.org', content: 'example.org', ttl: null })
    );
    expect(taken.status).toBe(409);
    expect(taken.message).toBe("Infoblox: The record 'old.example.org' already exists.");
  });

  it('ändert über die Kennung und entfernt über sie', async () => {
    const [old] = await provider.listRecords(access(), ZONE, ['old.example.org']);
    const moved = await provider.updateRecord(access(), ZONE, old, { type: 'A', name: 'old.example.org', content: '192.0.2.21', ttl: old.ttl });
    expect(moved.content).toBe('192.0.2.21');
    const put = appliance.calls.find((call) => call.method === 'PUT')!;
    expect(put.path).toBe(`/wapi/v2.2.2/${old.id}`);

    await provider.deleteRecord(access(), ZONE, moved);
    expect(await provider.listRecords(access(), ZONE, ['old.example.org'])).toEqual([]);
    expect((await failure(() => provider.deleteRecord(access(), ZONE, moved))).status).toBe(404);
  });

  it('fasst einen Host-Eintrag nicht an', async () => {
    const [hostAddress] = await provider.listRecords(access(), ZONE, ['server.example.org']);
    expect((await failure(() => provider.deleteRecord(access(), ZONE, hostAddress))).message).toContain('Host-Eintrag');
    expect(appliance.calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('schreibt nur die Arten, die es als Objekt kennt', async () => {
    expect(
      (await failure(() => provider.createRecord(access(), ZONE, { type: 'MX', name: 'x.example.org', content: 'mail', ttl: null }))).message
    ).toContain('MX-Eintrag');
  });
});

describe('probe', () => {
  it('prüft Anmeldung und View', async () => {
    const base = { server: 'infoblox.example.org', username: 'hapm', password: 'geh3im!', wapiVersion: '2.2.2', ca: null };
    await expect(provider.probe({ ...base, view: 'default' })).resolves.toBeUndefined();
    await expect(provider.probe({ ...base, view: 'fehlt' })).rejects.toThrow('gibt es auf der Appliance nicht');
    await expect(provider.probe({ ...base, view: 'default', password: 'x' })).rejects.toThrow('Anmeldung abgelehnt');
  });
});

describe('Fehler der Verbindung', () => {
  const failing = (code: string | undefined, name = 'Error') =>
    createInfoblox(async () => {
      const error = new Error('kaputt') as Error & { code?: string };
      error.name = name;
      if (code) error.code = code;
      throw error;
    });

  it('nennt ein Zertifikat, dem HAPM nicht vertraut, beim Namen', async () => {
    for (const code of ['SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']) {
      const told = await failure(() => failing(code).listZones(access(), 'example.org'));
      expect(told.message).toContain('vertraut HAPM nicht');
    }
  });

  it('nennt einen Namen, der nicht im Zertifikat steht', async () => {
    const told = await failure(() => failing('ERR_TLS_CERT_ALTNAME_INVALID').listZones(access(), 'example.org'));
    expect(told.message).toContain('ist nicht auf infoblox.example.org ausgestellt');
  });

  it('hält nur „nicht erreichbar" für einen Fehler, der nichts über die Eingabe sagt', async () => {
    await expect(failing('ECONNREFUSED').listZones(access(), 'example.org')).rejects.toBeInstanceOf(DnsUnreachableError);
    await expect(failing(undefined, 'TimeoutError').listZones(access(), 'example.org')).rejects.toThrow('nicht rechtzeitig');
    await expect(failing('SELF_SIGNED_CERT_IN_CHAIN').listZones(access(), 'example.org')).rejects.not.toBeInstanceOf(
      DnsUnreachableError
    );
  });
});

/**
 * Die Verbindung selbst, gegen einen HTTPS-Server mit einem Zertifikat einer
 * eigenen Stelle. Braucht `openssl` (unter Windows aus Git Bash). Ohne es wird
 * der Abschnitt übersprungen und sagt das.
 */
function selfSigned(dir: string): { key: string; cert: string } | null {
  try {
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=DNS:localhost',
        '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'crt.pem'),
      ],
      { stdio: 'ignore', env: { ...process.env, MSYS_NO_PATHCONV: '1' } }
    );
    return { key: readFileSync(join(dir, 'key.pem'), 'utf8'), cert: readFileSync(join(dir, 'crt.pem'), 'utf8') };
  } catch {
    return null;
  }
}

describe('httpsSend', () => {
  let dir: string;
  let material: { key: string; cert: string } | null = null;
  let server: Server | null = null;
  let port = 0;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'hapm-wapi-'));
    material = selfSigned(dir);
    if (!material) {
      console.warn('[infoblox] httpsSend übersprungen: openssl ist nicht im PATH.');
      return;
    }
    server = createServer({ key: material.key, cert: material.cert }, (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ pfad: req.url, methode: req.method }));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  const request = (over: Partial<WapiRequest>): WapiRequest => ({
    method: 'GET',
    host: 'localhost',
    port,
    path: '/wapi/v2.2.2/view',
    headers: { Accept: 'application/json' },
    ca: null,
    ...over,
  });

  it('vertraut dem Zertifikat mit hinterlegter Stelle', async (context) => {
    if (!material) return context.skip();
    const response = await httpsSend(request({ ca: material.cert }));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ pfad: '/wapi/v2.2.2/view', methode: 'GET' });
  });

  it('lehnt dasselbe Zertifikat ohne hinterlegte Stelle ab', async (context) => {
    if (!material) return context.skip();
    await expect(httpsSend(request({}))).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
  });

  it('lehnt einen Namen ab, auf den das Zertifikat nicht ausgestellt ist', async (context) => {
    if (!material) return context.skip();
    await expect(httpsSend(request({ host: '127.0.0.1', ca: material.cert }))).rejects.toMatchObject({
      code: 'ERR_TLS_CERT_ALTNAME_INVALID',
    });
  });

  it('macht aus beidem über den Anbieter die Meldung für Menschen', async (context) => {
    if (!material) return context.skip();
    const real = createInfoblox();
    const told = await failure(() => real.listZones(access({ server: `localhost:${port}` }), 'example.org'));
    expect(told.message).toContain('vertraut HAPM nicht');
  });
});
