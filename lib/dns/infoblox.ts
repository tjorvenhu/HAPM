/**
 * Der Zugang zu einer Infoblox-Appliance über ihre WAPI (REST über HTTPS,
 * Anmeldung mit Benutzer und Passwort). Die EINE Stelle, an der eine Anfrage
 * dorthin entsteht.
 *
 * ── Gebaut nach der Beschreibung, nicht gegen eine Appliance ──
 *
 * Beim Bau gab es keine Appliance. Die Aufrufe folgen der WAPI-Dokumentation
 * von Infoblox und dem acme.sh-Hook `dns_infoblox`, der dieselbe Schnittstelle
 * für TXT-Einträge benutzt (dieselbe Fassung, dieselbe Anmeldung, `view` als
 * Parameter). `tests/dns/infoblox.test.ts` prüft gegen einen Nachbau. Was
 * davon nie gegen ein echtes Gerät lief, steht in `docs/dns.md`. Wer hier
 * einen Fehler findet, findet ihn in dieser Datei und sonst nirgends.
 *
 * ── Was die WAPI anders macht ──
 *
 * - **Je Eintragsart ein eigenes Objekt**: `record:a`, `record:aaaa`,
 *   `record:cname`, `record:txt`. Gelesen wird je Art, mit dem vollen Namen
 *   und der DNS-View.
 * - **Ein Eintrag hat eine Kennung** (`_ref`), wie bei Cloudflare. Ändern und
 *   Entfernen gehen über sie.
 * - **Ein Host-Eintrag** (`record:host`) ist bei Infoblox ein eigenes Objekt,
 *   das Adressen trägt. Er erscheint hier als A oder AAAA und gesperrt
 *   (`locked`): HAPM sieht ihn, damit unter dem Namen kein zweiter Eintrag
 *   entsteht, und ändert ihn nicht.
 * - **Keine eigene TTL** heißt `use_ttl: false`: es gilt die der Zone.
 *
 * ── Zonen werden gesucht, nicht gelistet ──
 *
 * Ein Grid führt oft Tausende Zonen. Mit einer Domain (`near`) fragt
 * `listZones` gezielt nach ihr und ihren Eltern (`zone_auth?fqdn=`), ohne sie
 * blättert es durch alle.
 *
 * ── Das Zertifikat der Appliance wird geprüft, immer ──
 *
 * Es gibt keinen Schalter, der die Prüfung abstellt: darüber gehen Benutzer
 * und Passwort. Für eine eigene Zertifizierungsstelle wird ihr Zertifikat
 * hinterlegt (`ca`), es gilt dann zusätzlich zu den öffentlichen Stellen. Das
 * Zertifikat muss auf den eingetragenen Namen ausgestellt sein. `node:https`
 * und nicht `fetch`, weil nur dort eine eigene CA je Anfrage mitgehen kann.
 *
 * Die Zugangsdaten stehen in keiner URL und in keinem Log.
 */

import { request as httpsRequest } from 'node:https';
import { rootCertificates } from 'node:tls';
import { ApiError } from '../api';
import { msg, type Message } from '../i18n';
import { readInfobloxAccess, type InfobloxAccess } from './access';
import { DnsUnreachableError } from './errors';
import type { DnsRecord } from './records';
import type { DnsProvider, ProviderZone, RecordWrite, ZoneRef } from './provider';

const TIMEOUT_MS = 15_000;

/** So viele Objekte je Seite, und so viele Seiten höchstens: ein Riegel, nicht die erwartete Größe. */
const PAGE_SIZE = 500;
const MAX_PAGES = 40;

export interface WapiRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  host: string;
  port: number;
  /** Pfad samt Abfrage, ab `/wapi/`. */
  path: string;
  headers: Record<string, string>;
  body?: string;
  /** PEM einer eigenen Zertifizierungsstelle oder `null`. */
  ca: string | null;
}

export interface WapiResponse {
  status: number;
  body: string;
}

/** Eine Anfrage hin, eine Antwort zurück. Im Test eine nachgestellte Appliance. */
export type WapiSend = (request: WapiRequest) => Promise<WapiResponse>;

export const httpsSend: WapiSend = (input) =>
  new Promise<WapiResponse>((resolve, reject) => {
    const req = httpsRequest(
      {
        host: input.host,
        port: input.port,
        path: input.path,
        method: input.method,
        headers: input.headers,
        // Die eigene Stelle zusätzlich zu den öffentlichen, nicht statt ihrer.
        ...(input.ca ? { ca: [...rootCertificates, input.ca] } : {}),
        // Eine Verbindung je Anfrage: kein Zustand zwischen zwei Zugängen.
        agent: false,
        timeout: TIMEOUT_MS,
      },
      (res) => {
        res.setEncoding('utf8');
        let body = '';
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => {
      const error = new Error('Zeitüberschreitung');
      error.name = 'TimeoutError';
      req.destroy(error);
    });
    req.on('error', reject);
    if (input.body !== undefined) req.write(input.body);
    req.end();
  });

/**
 * Was eine gescheiterte Verbindung heißt. Der Code kommt von Node (TLS oder
 * Netz). Ein Zertifikat, dem HAPM nicht vertraut, ist eine Auskunft über die
 * Eingabe. Nicht erreichbar zu sein ist keine (`DnsUnreachableError`).
 */
function transportFailure(err: unknown, server: string): ApiError {
  const code = (err as { code?: unknown } | null)?.code;
  const name = err instanceof Error ? err.name : '';
  const told = tlsFailure(code, server);
  if (told) return new ApiError(told, 502);
  return new DnsUnreachableError(
    name === 'TimeoutError'
      ? msg('Die Appliance {server} hat nicht rechtzeitig geantwortet.', { server })
      : msg('Die Appliance {server} ist nicht erreichbar.', { server }),
    502
  );
}

function tlsFailure(code: unknown, server: string): Message | null {
  switch (code) {
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
      return msg(
        'Dem Zertifikat der Appliance {server} vertraut HAPM nicht. Hinterlegen Sie das Zertifikat der Zertifizierungsstelle, die es ausgestellt hat.',
        { server }
      );
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return msg(
        'Das Zertifikat der Appliance ist nicht auf {server} ausgestellt. Tragen Sie den Namen ein, der im Zertifikat steht.',
        { server }
      );
    case 'CERT_HAS_EXPIRED':
      return msg('Das Zertifikat der Appliance {server} ist abgelaufen.', { server });
    default:
      break;
  }
  if (typeof code === 'string' && code.startsWith('ERR_OSSL')) {
    return msg('Das hinterlegte CA-Zertifikat lässt sich nicht lesen. Bitte als PEM neu hinterlegen.');
  }
  return null;
}

interface RawRecord {
  _ref: string;
  name?: string;
  ipv4addr?: string;
  ipv6addr?: string;
  canonical?: string;
  text?: string;
  ttl?: number;
  use_ttl?: boolean;
  comment?: string;
  ipv4addrs?: { ipv4addr?: string }[];
  ipv6addrs?: { ipv6addr?: string }[];
}

interface RawZone {
  fqdn?: string;
  zone_format?: string;
}

/** Je Art: das Objekt der WAPI und das Feld, in dem der Wert steht. */
const OBJECTS: Record<string, { object: string; field: 'ipv4addr' | 'ipv6addr' | 'canonical' | 'text' }> = {
  A: { object: 'record:a', field: 'ipv4addr' },
  AAAA: { object: 'record:aaaa', field: 'ipv6addr' },
  CNAME: { object: 'record:cname', field: 'canonical' },
  TXT: { object: 'record:txt', field: 'text' },
};

const RETURN_FIELDS = 'name,ttl,use_ttl,comment';

const lower = (value: string) => value.trim().toLowerCase().replace(/\.+$/, '');

function toRecord(type: string, raw: RawRecord): DnsRecord {
  const { field } = OBJECTS[type];
  return {
    id: raw._ref,
    type,
    name: lower(raw.name ?? ''),
    content: type === 'CNAME' ? lower(raw[field] ?? '') : (raw[field] ?? ''),
    ttl: raw.use_ttl && typeof raw.ttl === 'number' ? raw.ttl : null,
    proxied: false,
    priority: null,
    comment: raw.comment ?? null,
    locked: false,
  };
}

/** Ein Host-Eintrag als gesperrte A- und AAAA-Einträge: sichtbar, nicht änderbar. */
function hostRecords(raw: RawRecord): DnsRecord[] {
  const base = {
    name: lower(raw.name ?? ''),
    ttl: raw.use_ttl && typeof raw.ttl === 'number' ? raw.ttl : null,
    proxied: false,
    priority: null,
    comment: raw.comment ?? null,
    locked: true,
  };
  return [
    ...(raw.ipv4addrs ?? []).flatMap((entry) =>
      entry.ipv4addr ? [{ ...base, id: `${raw._ref}#${entry.ipv4addr}`, type: 'A', content: entry.ipv4addr }] : []
    ),
    ...(raw.ipv6addrs ?? []).flatMap((entry) =>
      entry.ipv6addr ? [{ ...base, id: `${raw._ref}#${entry.ipv6addr}`, type: 'AAAA', content: entry.ipv6addr }] : []
    ),
  ];
}

function query(params: Record<string, string | number>): string {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
}

export interface InfobloxProvider extends DnsProvider {
  /**
   * Ob die Appliance die Anmeldung annimmt und die DNS-View kennt, ohne dass
   * eine Zone feststeht. Für den Einrichtungsassistenten.
   */
  probe(access: InfobloxAccess): Promise<void>;
}

export function createInfoblox(send: WapiSend = httpsSend): InfobloxProvider {
  function accessOf(token: string): InfobloxAccess {
    const access = readInfobloxAccess(token);
    if (!access) {
      throw new ApiError(msg('Die gespeicherten Zugangsdaten der Appliance sind unvollständig. Bitte neu hinterlegen.'), 409);
    }
    return access;
  }

  async function call<T>(
    access: InfobloxAccess,
    method: WapiRequest['method'],
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const [host, port] = access.server.split(':');
    let response: WapiResponse;
    try {
      response = await send({
        method,
        host,
        port: port ? Number(port) : 443,
        path: `/wapi/v${access.wapiVersion}/${path}`,
        headers: {
          Authorization: `Basic ${Buffer.from(`${access.username}:${access.password}`, 'utf8').toString('base64')}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ca: access.ca,
      });
    } catch (err) {
      throw transportFailure(err, access.server);
    }

    if (response.status === 401) {
      throw new ApiError(
        msg('Infoblox hat die Anmeldung abgelehnt. Stimmen Benutzer und Passwort, und darf das Konto die API benutzen?'),
        502
      );
    }
    if (response.status === 403) {
      throw new ApiError(msg('Der Benutzer {user} darf das bei Infoblox nicht.', { user: access.username }), 502);
    }

    let parsed: unknown = null;
    try {
      parsed = response.body === '' ? null : JSON.parse(response.body);
    } catch {
      parsed = null;
    }

    if (response.status === 404) throw new ApiError(msg('Diesen Eintrag gibt es bei Infoblox nicht (mehr).'), 404);
    if (response.status < 200 || response.status >= 300) {
      // Die WAPI antwortet mit `{ Error, code, text }`, und `text` ist der Satz für Menschen.
      const detail = (parsed as { text?: unknown } | null)?.text;
      throw new ApiError(
        typeof detail === 'string' && detail
          ? msg('Infoblox: {message}', { message: detail })
          : msg('Infoblox hat mit {status} geantwortet.', { status: response.status }),
        response.status === 400 ? 409 : 502
      );
    }
    return parsed as T;
  }

  /** Alle Objekte zu einer Abfrage, über alle Seiten. */
  async function list<T>(access: InfobloxAccess, object: string, params: Record<string, string | number>): Promise<T[]> {
    const found: T[] = [];
    let pageId: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const path: string = pageId
        ? `${object}?${query({ _page_id: pageId })}`
        : `${object}?${query({ ...params, _paging: 1, _return_as_object: 1, _max_results: PAGE_SIZE })}`;
      const body = await call<{ result?: T[]; next_page_id?: string }>(access, 'GET', path);
      found.push(...(body?.result ?? []));
      pageId = body?.next_page_id ?? null;
      if (!pageId) return found;
    }
    // Eine abgeschnittene Liste sähe aus wie „gibt es nicht".
    throw new ApiError(msg('Infoblox liefert mehr als {count} Objekte. So viele liest HAPM nicht.', { count: PAGE_SIZE * MAX_PAGES }), 502);
  }

  async function viewExists(access: InfobloxAccess): Promise<boolean> {
    const views = await call<unknown[]>(access, 'GET', `view?${query({ name: access.view, _return_fields: 'name' })}`);
    return Array.isArray(views) && views.length > 0;
  }

  async function assertView(access: InfobloxAccess): Promise<void> {
    if (!(await viewExists(access))) {
      throw new ApiError(msg('Die DNS-View "{view}" gibt es auf der Appliance nicht.', { view: access.view }), 502);
    }
  }

  function zoneOf(access: InfobloxAccess, raw: RawZone): ProviderZone | null {
    // Rückwärtszonen (`IPV4`, `IPV6`) tragen keine Namen von Diensten.
    if (!raw.fqdn || (raw.zone_format && raw.zone_format !== 'FORWARD')) return null;
    // Die Kennung nennt Appliance und View: eine eigene braucht hier niemand.
    return { id: `${access.server}/${access.view}`, name: lower(raw.fqdn), delegated: null };
  }

  async function recordsBy(access: InfobloxAccess, filter: Record<string, string>): Promise<DnsRecord[]> {
    const typed = await Promise.all(
      Object.entries(OBJECTS).map(async ([type, { object, field }]) => {
        const raws = await list<RawRecord>(access, object, {
          ...filter,
          view: access.view,
          _return_fields: `${RETURN_FIELDS},${field}`,
        });
        return raws.map((raw) => toRecord(type, raw));
      })
    );
    const hosts = await list<RawRecord>(access, 'record:host', {
      ...filter,
      view: access.view,
      _return_fields: `${RETURN_FIELDS},ipv4addrs,ipv6addrs`,
    });
    return [...typed.flat(), ...hosts.flatMap(hostRecords)];
  }

  function writeBody(access: InfobloxAccess, input: RecordWrite): { object: string; body: Record<string, unknown> } {
    const target = OBJECTS[input.type.toUpperCase()];
    if (!target) throw new ApiError(msg('Einen {type}-Eintrag schreibt HAPM bei Infoblox nicht.', { type: input.type }));
    return {
      object: target.object,
      body: {
        name: lower(input.name),
        [target.field]: target.field === 'canonical' ? lower(input.content) : input.content.trim(),
        ...(input.ttl === null ? { use_ttl: false } : { ttl: input.ttl, use_ttl: true }),
        ...(input.comment === undefined ? {} : { comment: input.comment }),
      },
    };
  }

  /** Nach dem Schreiben liest HAPM den Eintrag über seine Kennung, statt die Eingabe zu glauben. */
  async function readBack(access: InfobloxAccess, ref: unknown, type: string): Promise<DnsRecord> {
    if (typeof ref !== 'string' || ref === '') {
      throw new ApiError(msg('Infoblox hat keine Kennung des Eintrags zurückgegeben. Ob er gespeichert ist, ist unbekannt.'), 502);
    }
    const { field } = OBJECTS[type];
    const raw = await call<RawRecord>(access, 'GET', `${ref}?${query({ _return_fields: `${RETURN_FIELDS},${field}` })}`);
    return toRecord(type, { ...raw, _ref: raw?._ref ?? ref });
  }

  function assertOwn(current: DnsRecord): void {
    if (current.locked || current.id.includes('#')) {
      throw new ApiError(
        msg('{name} ist bei Infoblox ein Host-Eintrag. HAPM ändert ihn nicht.', { name: current.name }),
        409
      );
    }
  }

  return {
    id: 'infoblox',

    async probe(access) {
      await assertView(access);
    },

    async listZones(token, near): Promise<ProviderZone[]> {
      const access = accessOf(token);
      const fields = { view: access.view, _return_fields: 'fqdn,zone_format' };
      if (!near) {
        const all = await list<RawZone>(access, 'zone_auth', fields);
        return all.flatMap((raw) => zoneOf(access, raw) ?? []);
      }
      const labels = lower(near).replace(/^\*\./, '').split('.').filter(Boolean);
      const candidates = labels.slice(0, Math.max(labels.length - 1, 0)).map((_, index) => labels.slice(index).join('.'));
      const found = await Promise.all(
        candidates.map((fqdn) => list<RawZone>(access, 'zone_auth', { ...fields, fqdn }))
      );
      const zones = found.flat().flatMap((raw) => zoneOf(access, raw) ?? []);
      // Keine Zone kann auch heißen: die View stimmt nicht. Das ist eine andere Meldung.
      if (zones.length === 0) await assertView(access);
      return zones;
    },

    async listRecords(token, zone: ZoneRef, names): Promise<DnsRecord[]> {
      const access = accessOf(token);
      if (!names || names.length === 0) return recordsBy(access, { zone: lower(zone.name) });
      const wanted = [...new Set(names.map(lower))];
      const found = await Promise.all(wanted.map((name) => recordsBy(access, { name })));
      return found.flat();
    },

    async createRecord(token, _zone, input): Promise<DnsRecord> {
      const access = accessOf(token);
      const { object, body } = writeBody(access, input);
      const ref = await call<string>(access, 'POST', object, { ...body, view: access.view });
      return readBack(access, ref, input.type.toUpperCase());
    },

    async updateRecord(token, zone, current, input): Promise<DnsRecord> {
      const access = accessOf(token);
      assertOwn(current);
      const type = input.type.toUpperCase();
      if (type !== current.type.toUpperCase()) {
        // Eine andere Art ist bei Infoblox ein anderes Objekt: erst das neue, dann das alte weg.
        const created = await this.createRecord(token, zone, input);
        await call<string>(access, 'DELETE', current.id);
        return created;
      }
      const { body } = writeBody(access, input);
      const ref = await call<string>(access, 'PUT', current.id, body);
      return readBack(access, ref, type);
    },

    async deleteRecord(token, _zone, current): Promise<void> {
      const access = accessOf(token);
      assertOwn(current);
      await call<string>(access, 'DELETE', current.id);
    },
  };
}

export const infoblox: InfobloxProvider = createInfoblox();
