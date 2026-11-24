/**
 * Der Zugang zu Cloudflare. Die EINE Stelle, an der eine Anfrage dorthin
 * entsteht — Routen und Vorgänge rufen diese Funktionen und bauen keine URL.
 *
 * ── Warum der Fehler übersetzt wird und nicht durchgereicht ──
 *
 * Cloudflare antwortet mit einer Liste aus Code und englischem Satz
 * (`{"errors":[{"code":9103,"message":"Unknown X-Auth-Key or X-Auth-Email"}]}`).
 * Der Satz ist als Auskunft brauchbar, der Code nicht — und die drei Fälle, die
 * hier wirklich vorkommen, sind es wert, benannt zu werden: der Token ist
 * abgelaufen, der Token darf die Zone nicht, oder der Eintrag steht schon.
 * Alles andere geht mit seinem englischen Satz weiter; ihn zu verschlucken wäre
 * schlimmer als ihn nicht übersetzt zu haben.
 *
 * ── Der Token steht in keiner URL und in keinem Log ──
 *
 * Er geht ausschließlich im `Authorization`-Header mit. Deshalb nimmt jede
 * Funktion ihn als ersten Parameter statt aus einer Modulvariablen: es gibt
 * einen Token je Zone, und ein Modulzustand wäre genau die Sorte zweite Quelle,
 * die beim zweiten gleichzeitigen Aufruf den falschen erwischt.
 */

import { ApiError } from '../api';
import type { DnsRecord } from './records';

const API = 'https://api.cloudflare.com/client/v4';

/** Cloudflare antwortet in aller Regel binnen Sekunden. Zehn ist großzügig. */
const TIMEOUT_MS = 10_000;

interface CloudflareEnvelope<T> {
  success: boolean;
  result: T;
  errors?: { code: number; message: string }[];
  result_info?: { page: number; total_pages: number };
}

interface RawRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied?: boolean;
  priority?: number;
  comment?: string | null;
  /** Cloudflare pflegt ihn selbst (SOA und Ähnliches). */
  locked?: boolean;
}

interface RawZone {
  id: string;
  name: string;
  status: string;
  account?: { name?: string };
}

function message(body: CloudflareEnvelope<unknown> | null, fallback: string): string {
  const first = body?.errors?.[0];
  if (!first) return fallback;
  switch (first.code) {
    case 6003:
    case 9103:
    case 10000:
      return 'Cloudflare hat den API-Token abgelehnt. Ist er abgelaufen oder wurde er zurückgezogen?';
    case 81057:
      return 'Ein Eintrag mit diesem Namen und dieser Art steht dort bereits.';
    case 81044:
      return 'Cloudflare kennt keinen Eintrag mit dieser ID mehr. Vermutlich wurde er im Dashboard gelöscht.';
    default:
      return `Cloudflare: ${first.message}`;
  }
}

async function call<T>(
  token: string,
  path: string,
  init: RequestInit = {}
): Promise<CloudflareEnvelope<T>> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // Next cacht `fetch` in Server-Komponenten von sich aus. Ein
      // zwischengespeicherter Eintragsbestand wäre genau die zweite Quelle,
      // gegen die es hier keine Collection gibt.
      cache: 'no-store',
    });
  } catch (err) {
    // Ein Timeout ist hier kein 500er: die Zone ist erreichbar oder eben nicht,
    // und das ist eine Auskunft an den Benutzer.
    const reason = err instanceof Error && err.name === 'TimeoutError'
      ? 'Cloudflare hat nicht rechtzeitig geantwortet.'
      : 'Cloudflare ist nicht erreichbar.';
    throw new ApiError(reason, 502);
  }

  let body: CloudflareEnvelope<T> | null = null;
  try {
    body = (await response.json()) as CloudflareEnvelope<T>;
  } catch {
    body = null;
  }

  if (!response.ok || !body?.success) {
    // 403 heißt bei Cloudflare fast immer: der Token existiert, darf diese Zone
    // aber nicht. Das ist eine andere Handlung als „Token erneuern".
    const fallback =
      response.status === 403
        ? 'Der API-Token darf diese Zone nicht bearbeiten. Er braucht die Berechtigung „Zone → DNS → Bearbeiten".'
        : `Cloudflare hat mit ${response.status} geantwortet.`;
    throw new ApiError(message(body, fallback), response.status === 403 ? 403 : 502);
  }

  return body;
}

function toRecord(raw: RawRecord): DnsRecord {
  return {
    id: raw.id,
    type: raw.type,
    name: raw.name,
    content: raw.content,
    ttl: raw.ttl,
    proxied: raw.proxied ?? false,
    // `null` und nicht `0`: eine Priorität hat nur, wer eine hat. Eine erfundene
    // 0 sähe in der Tabelle aus wie „höchste Priorität".
    priority: typeof raw.priority === 'number' ? raw.priority : null,
    comment: raw.comment ?? null,
    locked: raw.locked ?? false,
  };
}

export interface CloudflareZone {
  id: string;
  name: string;
  /** `active`, solange die Nameserver auf Cloudflare zeigen. */
  status: string;
  accountName: string | null;
}

/**
 * Die Zone zu einem Namen — der Vorgang beim Einrichten einer Domain.
 *
 * Gesucht wird über den Namen und nicht über die volle Liste: ein Token kann
 * über hundert Zonen tragen, und die richtige davon kennt der Benutzer schon.
 * `null` heißt: der Token sieht diese Zone nicht. Das ist kein Fehler, sondern
 * die häufigste Fehleingabe — ein Token, der für eine andere Domain erzeugt
 * wurde.
 */
export async function findZone(token: string, name: string): Promise<CloudflareZone | null> {
  const body = await call<RawZone[]>(token, `/zones?name=${encodeURIComponent(name)}`);
  const zone = body.result[0];
  if (!zone) return null;
  return {
    id: zone.id,
    name: zone.name,
    status: zone.status,
    accountName: zone.account?.name ?? null,
  };
}

/** Die Zonen, die dieser Token überhaupt sieht. Für den Hinweis im Dialog. */
export async function listZones(token: string): Promise<CloudflareZone[]> {
  const body = await call<RawZone[]>(token, '/zones?per_page=50');
  return body.result.map((zone) => ({
    id: zone.id,
    name: zone.name,
    status: zone.status,
    accountName: zone.account?.name ?? null,
  }));
}

/**
 * Alle Einträge einer Zone.
 *
 * Blättert bis zum Ende. Eine Zone mit über hundert Einträgen ist der Normalfall
 * bei einer gewachsenen Domain, und eine Liste, die stillschweigend nach der
 * ersten Seite aufhört, zeigt eine Zone als leer, die es nicht ist — dieselbe
 * Überlegung wie bei `listAll` in lib/db.
 */
export async function listRecords(token: string, zoneId: string): Promise<DnsRecord[]> {
  const records: DnsRecord[] = [];
  let page = 1;
  // Der Deckel ist ein Riegel gegen eine Endlosschleife, falls Cloudflare
  // `total_pages` einmal nicht mitschickt — nicht die erwartete Größe.
  while (page <= 20) {
    const body = await call<RawRecord[]>(
      token,
      `/zones/${zoneId}/dns_records?per_page=100&page=${page}&order=type`
    );
    records.push(...body.result.map(toRecord));
    const total = body.result_info?.total_pages ?? 1;
    if (page >= total) break;
    page += 1;
  }
  return records;
}

export interface RecordPayload {
  type: string;
  /** Der volle Name. Cloudflare nimmt auch den relativen an, gibt aber immer den vollen zurück. */
  name: string;
  content: string;
  ttl: number;
  proxied?: boolean;
  priority?: number;
  comment?: string;
}

function payload(input: RecordPayload): string {
  return JSON.stringify({
    type: input.type,
    name: input.name,
    content: input.content,
    ttl: input.ttl,
    // Nur mitschicken, wo es etwas bedeutet: ein `proxied: false` an einem
    // TXT-Eintrag lehnt Cloudflare ab.
    ...(input.proxied === undefined ? {} : { proxied: input.proxied }),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    ...(input.comment === undefined ? {} : { comment: input.comment }),
  });
}

export async function createRecord(
  token: string,
  zoneId: string,
  input: RecordPayload
): Promise<DnsRecord> {
  const body = await call<RawRecord>(token, `/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: payload(input),
  });
  return toRecord(body.result);
}

export async function updateRecord(
  token: string,
  zoneId: string,
  recordId: string,
  input: RecordPayload
): Promise<DnsRecord> {
  // PUT und nicht PATCH: der Rumpf beschreibt den Eintrag vollständig, und ein
  // PATCH ließe ein weggelassenes Feld stehen — beim Wechsel von MX auf A wäre
  // das eine Priorität an einem Eintrag, der keine hat.
  const body = await call<RawRecord>(token, `/zones/${zoneId}/dns_records/${recordId}`, {
    method: 'PUT',
    body: payload(input),
  });
  return toRecord(body.result);
}

export async function deleteRecord(
  token: string,
  zoneId: string,
  recordId: string
): Promise<void> {
  await call<{ id: string }>(token, `/zones/${zoneId}/dns_records/${recordId}`, {
    method: 'DELETE',
  });
}
