/**
 * Der Zugang zu Hetzner (DNS in der Cloud-Konsole). Die EINE Stelle, an der
 * eine Anfrage dorthin entsteht.
 *
 * Die API ist die der Hetzner Cloud (`https://api.hetzner.cloud/v1`, Abschnitte
 * „Zones" und „Zone RRSets" der Referenz), mit dem Token eines Projekts als
 * Bearer. Es ist dasselbe Token, das der acme.sh-Hook `dns_hetznercloud` als
 * `HETZNER_TOKEN` benutzt, und es gilt für alle Zonen seines Projekts.
 *
 * ── Eine Änderung ist erst fertig, wenn ihre Aktion es ist ──
 *
 * Jeder schreibende Aufruf antwortet mit einer Aktion (`running`) und nicht mit
 * dem fertigen Eintrag. Wer hier gleich zurückkäme, zeigte danach eine Liste,
 * in der die Änderung noch fehlt, und der nächste Schritt (ein Zertifikat über
 * die frisch angelegte Domain) liefe gegen einen Eintrag, den es noch nicht
 * gibt. `settle` wartet deshalb, bis die Aktion `success` oder `error` meldet.
 *
 * ── Wie Einträge auf RRSets abgebildet werden ──
 *
 * Steht in `hetzner-rrsets.ts`, rein und ohne Netz. Diese Datei liest vor jedem
 * Schreiben den betroffenen Satz, lässt sich dort den Plan geben und führt ihn
 * aus.
 *
 * Der Token steht in keiner URL und in keinem Log, wie bei Cloudflare.
 */

import { ApiError } from '../api';
import { msg, translate, type Locale, type Message } from '../i18n';
import {
  decodeRecordId,
  hasValue,
  planCreate,
  planDelete,
  planUpdate,
  rrsetName,
  rrsetToRecords,
  rrsetsToRecords,
  writeConflict,
  writeValue,
  type HetznerRRSet,
  type RecordKey,
  type RRSetStep,
  type ValueTarget,
} from './hetzner-rrsets';
import type { DnsRecord } from './records';
import type { DnsProvider, ProviderZone, RecordWrite, ZoneRef } from './provider';

const API = 'https://api.hetzner.cloud/v1';

const TIMEOUT_MS = 10_000;

/** Mehr gibt die API je Seite nicht her. */
const PER_PAGE = 50;

/** Ein Riegel gegen eine Endlosschleife, nicht die erwartete Größe: 5000 Sätze. */
const MAX_PAGES = 100;

/**
 * Die Pausen zwischen zwei Nachfragen nach einer Aktion, zusammen gut 20
 * Sekunden. Eine Änderung an einem Satz ist in aller Regel nach der ersten
 * durch; die Referenz bittet darum, nicht dichter zu fragen als nötig.
 */
const SETTLE_DELAYS_MS = [300, 700, 1000, 1500, 2000, 2500, 3000, 4000, 5000];

/** Wie oft ein Aufruf wiederholt wird, den Hetzner wegen einer laufenden Änderung abweist. */
const BUSY_RETRIES = 3;

interface RawError {
  code?: string;
  message?: string;
}

interface RawAction {
  id: number;
  status: 'running' | 'success' | 'error';
  error?: RawError | null;
}

interface RawZone {
  id: number;
  name: string;
  authoritative_nameservers?: { delegation_status?: string };
}

interface Pagination {
  meta?: { pagination?: { next_page?: number | null } };
}

/** Trägt den Code von Hetzner mit, damit `call` und seine Aufrufer danach entscheiden können. */
class HetznerError extends ApiError {
  constructor(
    message: Message,
    status: number,
    readonly code: string | null
  ) {
    super(message, status);
  }
}

/**
 * Ein Schritt nach dem ersten ist gescheitert. Der Grund ist die Meldung des
 * Schritts, in derselben Sprache wie der Satz dahinter.
 */
class PartialChangeError extends ApiError {
  constructor(readonly reason: ApiError) {
    super(
      msg('{reason} Ein Teil der Änderung ist bereits ausgeführt, bitte den Stand in der Liste prüfen.', {
        reason: reason.message,
      }),
      reason.status
    );
  }

  override localized(locale: Locale): string {
    return translate(locale, this.text, { reason: this.reason.localized(locale) });
  }
}

/**
 * Aus Status und Code eine Meldung, mit der jemand etwas anfangen kann.
 *
 * Benannt werden die Fälle, die hier wirklich vorkommen. Alles andere geht mit
 * dem englischen Satz von Hetzner weiter: ihn zu verschlucken wäre schlimmer,
 * als ihn nicht übersetzt zu haben.
 */
function failure(status: number, error: RawError | null): HetznerError {
  const code = error?.code ?? null;
  const told = (message: Message, as = 502) => new HetznerError(message, as, code);

  if (status === 401 || code === 'unauthorized') {
    return told(
      msg('Hetzner hat den API-Token abgelehnt. Ist er vollständig kopiert, und stammt er aus dem Projekt der Zone?')
    );
  }
  if (code === 'protected') {
    return told(msg('Der Eintrag ist bei Hetzner gegen Änderungen geschützt.'), 409);
  }
  if (code === 'locked' || code === 'conflict') {
    return told(
      msg('Bei Hetzner läuft gerade eine andere Änderung an dieser Zone. Bitte gleich noch einmal versuchen.'),
      409
    );
  }
  if (status === 403) {
    return told(
      msg('Der API-Token darf das nicht. Er braucht Lese- und Schreibrecht im Projekt der Zone.'),
      403
    );
  }
  if (code === 'incorrect_zone_mode') {
    return told(
      msg(
        'Hetzner führt diese Zone als Sekundärzone. Ihre Einträge kommen von einem anderen Nameserver und lassen sich hier nicht bearbeiten.'
      ),
      409
    );
  }
  if (status === 404) {
    return told(
      msg('Hetzner kennt diese Zone oder diesen Eintrag nicht (mehr). Vermutlich wurde er in der Konsole gelöscht.'),
      404
    );
  }
  if (status === 429) {
    return told(
      msg('Hetzner nimmt von diesem Projekt gerade keine weiteren Anfragen an. Bitte in einer Minute noch einmal versuchen.')
    );
  }
  return told(
    error?.message
      ? msg('Hetzner: {message}', { message: error.message })
      : msg('Hetzner hat mit {status} geantwortet.', { status })
  );
}

async function call<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...init.headers,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // Wie bei Cloudflare: ein zwischengespeicherter Bestand wäre die zweite
      // Quelle, gegen die es hier keine Collection gibt.
      cache: 'no-store',
    });
  } catch (err) {
    const reason =
      err instanceof Error && err.name === 'TimeoutError'
        ? msg('Hetzner hat nicht rechtzeitig geantwortet.')
        : msg('Hetzner ist nicht erreichbar.');
    throw new ApiError(reason, 502);
  }

  let body: (T & { error?: RawError }) | null = null;
  try {
    body = (await response.json()) as T & { error?: RawError };
  } catch {
    body = null;
  }

  if (!response.ok || !body) throw failure(response.status, body?.error ?? null);
  return body;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Warten, bis Hetzner die Änderung ausgeführt hat.
 *
 * Läuft die Zeit ab, ist das ein Fehler und kein stilles Weiter: ob der Eintrag
 * steht, weiß an dieser Stelle niemand, und „gespeichert" wäre geraten.
 */
async function settle(token: string, started: RawAction | undefined): Promise<void> {
  let action = started;
  for (const delay of SETTLE_DELAYS_MS) {
    if (!action || action.status === 'success') return;
    if (action.status === 'error') break;
    await pause(delay);
    action = (await call<{ action: RawAction }>(token, `/actions/${action.id}`)).action;
  }
  if (!action || action.status === 'success') return;
  if (action.status === 'error') {
    throw new ApiError(
      action.error?.message
        ? msg('Hetzner hat die Änderung nicht ausgeführt: {reason}.', { reason: action.error.message })
        : msg('Hetzner hat die Änderung nicht ausgeführt: ohne Angabe eines Grundes.'),
      502
    );
  }
  throw new ApiError(
    msg('Hetzner hat die Änderung angenommen, aber noch nicht ausgeführt. Ob der Eintrag steht, zeigt die Liste in ein paar Sekunden.'),
    502
  );
}

function rrsetPath(zone: ZoneRef, key: Pick<RecordKey, 'name' | 'type'>): string {
  return `/zones/${encodeURIComponent(zone.id)}/rrsets/${encodeURIComponent(key.name)}/${encodeURIComponent(key.type)}`;
}

/**
 * Einen Schritt ausführen und abwarten.
 *
 * `locked` und `conflict` heißen: an der Zone läuft gerade eine andere
 * Änderung. Das ist der Fall „zwei Leute gleichzeitig am selben Namen", und
 * weil jeder Schritt nur seinen eigenen Wert anfasst, ist Wiederholen richtig
 * und verliert nichts.
 */
async function act(token: string, zone: ZoneRef, step: RRSetStep): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const body = await call<{ action?: RawAction }>(
        token,
        `${rrsetPath(zone, step)}/actions/${step.action}`,
        { method: 'POST', body: JSON.stringify(step.body) }
      );
      await settle(token, body.action);
      return;
    } catch (err) {
      const busy = err instanceof HetznerError && (err.code === 'locked' || err.code === 'conflict');
      if (!busy || attempt >= BUSY_RETRIES) throw err;
      await pause(500 * (attempt + 1));
    }
  }
}

/**
 * Die Schritte eines Plans der Reihe nach.
 *
 * Scheitert einer nach dem ersten, sagt die Meldung das dazu: der neue Wert
 * steht dann schon, der alte noch. Verloren ist dabei nichts, aber wer nur
 * „fehlgeschlagen" liest, sucht den Fehler an der falschen Stelle.
 */
async function run(token: string, zone: ZoneRef, steps: RRSetStep[]): Promise<void> {
  for (const [index, step] of steps.entries()) {
    try {
      await act(token, zone, step);
    } catch (err) {
      if (index === 0 || !(err instanceof ApiError)) throw err;
      throw new PartialChangeError(err);
    }
  }
}

async function readRRSet(
  token: string,
  zone: ZoneRef,
  key: Pick<RecordKey, 'name' | 'type'>
): Promise<HetznerRRSet | null> {
  try {
    return (await call<{ rrset: HetznerRRSet }>(token, rrsetPath(zone, key))).rrset;
  } catch (err) {
    if (err instanceof HetznerError && err.status === 404) return null;
    throw err;
  }
}

function target(input: RecordWrite, zone: ZoneRef): ValueTarget {
  return {
    name: rrsetName(input.name, zone.name),
    type: input.type,
    value: writeValue(input.type, input.content, input.priority ?? null),
    comment: input.comment ?? null,
    ttl: input.ttl,
  };
}

/** Der Eintrag, wie er nach dem Schreiben dasteht: aus dem, was geschrieben wurde. */
function asRecord(next: ValueTarget, ttl: number | null, zone: ZoneRef): DnsRecord {
  const rrset: HetznerRRSet = {
    name: next.name,
    type: next.type,
    ttl,
    records: [next.comment ? { value: next.value, comment: next.comment } : { value: next.value }],
  };
  return rrsetToRecords(rrset, zone.name)[0];
}

function keyOf(current: DnsRecord): RecordKey {
  const key = decodeRecordId(current.id);
  if (!key) throw new ApiError(msg('Diesen Eintrag gibt es in der Zone nicht (mehr).'), 404);
  return key;
}

/**
 * Die Zonen des Projekts, zu dem der Token gehört.
 *
 * `delegated` kommt aus der Prüfung, die Hetzner selbst führt
 * (`delegation_status`). `unknown` bleibt unbekannt: eine frisch angelegte Zone
 * ist noch nicht geprüft, und das ist keine Aussage über ihre Nameserver.
 */
async function listZones(token: string): Promise<ProviderZone[]> {
  const zones: ProviderZone[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = await call<{ zones: RawZone[] } & Pagination>(
      token,
      `/zones?per_page=${PER_PAGE}&page=${page}`
    );
    for (const zone of body.zones) {
      const status = zone.authoritative_nameservers?.delegation_status;
      zones.push({
        id: String(zone.id),
        name: zone.name,
        delegated:
          status === 'valid' || status === 'partially-valid'
            ? true
            : status === undefined || status === 'unknown'
              ? null
              : false,
      });
    }
    if (!body.meta?.pagination?.next_page) break;
  }
  return zones;
}

/**
 * Alle Sätze einer Zone, als einzelne Einträge.
 *
 * Blättert bis zum Ende. Reicht der Deckel nicht, ist das ein Fehler: eine
 * Liste, die stillschweigend aufhört, zeigte einen Namen als frei, der es nicht
 * ist, und `sync.ts` legte dort einen Eintrag an.
 */
async function listRecords(token: string, zone: ZoneRef): Promise<DnsRecord[]> {
  const rrsets: HetznerRRSet[] = [];
  for (let page = 1; ; page += 1) {
    if (page > MAX_PAGES) {
      throw new ApiError(
        msg('Die Zone {zone} hat mehr Einträge, als HAPM liest ({count} Namen).', {
          zone: zone.name,
          count: MAX_PAGES * PER_PAGE,
        }),
        502
      );
    }
    const body = await call<{ rrsets: HetznerRRSet[] } & Pagination>(
      token,
      `/zones/${encodeURIComponent(zone.id)}/rrsets?per_page=${PER_PAGE}&page=${page}`
    );
    rrsets.push(...body.rrsets);
    if (!body.meta?.pagination?.next_page) break;
  }
  return rrsetsToRecords(rrsets, zone.name);
}

async function createRecord(token: string, zone: ZoneRef, input: RecordWrite): Promise<DnsRecord> {
  const next = target(input, zone);
  const existing = await readRRSet(token, zone, next);
  const conflict = writeConflict(next, existing, null);
  if (conflict) throw new ApiError(conflict, 409);

  const steps = planCreate(next, existing);
  await run(token, zone, steps);
  const ttl = existing && !steps.some((step) => step.action === 'change_ttl') ? existing.ttl : next.ttl;
  return asRecord(next, ttl, zone);
}

async function updateRecord(
  token: string,
  zone: ZoneRef,
  current: DnsRecord,
  input: RecordWrite
): Promise<DnsRecord> {
  const key = keyOf(current);
  const next = target(input, zone);
  const moved = key.name !== next.name || key.type !== next.type;

  const existing = await readRRSet(token, zone, next);
  // Der Satz kommt frisch von Hetzner und nicht aus der Liste, die die Seite
  // vor einer Minute gelesen hat: an ihm hängen die TTL, die mitgeschickt
  // werden muss, und die Frage, ob der Wert überhaupt noch dasteht.
  if (!moved && !hasValue(existing, key.value)) {
    throw new ApiError(msg('Diesen Eintrag gibt es in der Zone nicht (mehr).'), 404);
  }
  const conflict = writeConflict(next, existing, key);
  if (conflict) throw new ApiError(conflict, 409);

  const steps = planUpdate(key, next, existing);
  await run(token, zone, steps);
  const ttl = existing && !steps.some((step) => step.action === 'change_ttl') ? existing.ttl : next.ttl;
  return asRecord(next, ttl, zone);
}

async function deleteRecord(token: string, zone: ZoneRef, current: DnsRecord): Promise<void> {
  await run(token, zone, planDelete(keyOf(current)));
}

export const hetzner: DnsProvider = {
  id: 'hetzner',
  listZones,
  listRecords,
  createRecord,
  updateRecord,
  deleteRecord,
};
