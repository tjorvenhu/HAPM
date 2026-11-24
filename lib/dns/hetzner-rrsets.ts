/**
 * RRSet ↔ Einträge: wie aus dem, was Hetzner führt, das wird, womit HAPM
 * rechnet, und zurück.
 *
 * Hetzner kennt keinen einzelnen Eintrag mit Kennung. Es führt je Name und Art
 * einen Satz von Werten (`www/A` mit zwei Adressen), und die TTL gehört dem
 * Satz. HAPM rechnet wie bei Cloudflare mit einem Eintrag je Wert.
 * Rein und ohne Netz, damit sich genau diese Abbildung prüfen lässt
 * (`tests/dns/hetzner-rrsets.test.ts`).
 *
 * ── Die Kennung ist Name, Art und Wert ──
 *
 * So benennt Hetzner einen Wert selbst („The value is used to identify the
 * record in an RRSet"). Sie wird lesbar verpackt und nicht gehasht: zum
 * Entfernen braucht es den Wert WÖRTLICH, wie Hetzner ihn führt, und der ist
 * aus der Anzeige nicht sicher zurückzurechnen (`"a" "b"` und `"ab"` sind
 * derselbe TXT-Text). Ändert jemand den Wert in der Konsole, ist es ein anderer
 * Eintrag mit anderer Kennung, und der alte ist „nicht mehr da". Das stimmt.
 *
 * ── Geschrieben wird je Wert, nie der ganze Satz ──
 *
 * `add_records` und `remove_records` fassen bei Hetzner nur den genannten Wert
 * an. Ein Satz, der hier gelesen, im Speicher geändert und mit `set_records`
 * zurückgeschrieben würde, nähme einen Wert mit, den jemand anderes in der
 * Zwischenzeit daneben gesetzt hat. Deshalb sind die Pläne unten Folgen aus
 * diesen beiden Aktionen, und beim Ändern kommt der neue Wert zuerst: so ist
 * der Name nie leer (ein leerer Satz wird bei Hetzner samt seiner TTL
 * gelöscht), und scheitert der zweite Schritt, stehen beide Werte da und keiner
 * fehlt.
 *
 * Die eine Ausnahme ist der CNAME: ein Name trägt nur einen, „erst hinzufügen"
 * geht dort nicht. Sein Wert wird mit `set_records` ersetzt, und weil der Satz
 * nur diesen einen Wert hat, geht dabei nichts Fremdes verloren.
 *
 * ── Wie Hetzner Werte schreibt ──
 *
 * In der Schreibweise einer Zonendatei. Ziele von CNAME, MX und NS enden auf
 * einen Punkt (`mail.example.org.`), die Priorität steht vor dem Ziel
 * (`10 mail.example.org.`), ein TXT-Wert steht in Anführungszeichen und wird ab
 * 255 Zeichen geteilt. HAPM rechnet in der Form, die Cloudflare auch hat: Ziel
 * ohne Punkt, Priorität als eigenes Feld, Text ohne Anführungszeichen.
 */

import { msg, type Message } from '../i18n';
import { recordFqdn, recordName } from './zones';
import type { DnsRecord } from './records';

export interface HetznerRecord {
  value: string;
  comment?: string;
}

export interface HetznerRRSet {
  /** Relativ zur Zone, `@` ist die Zone selbst. */
  name: string;
  type: string;
  /** `null`: es gilt die Vorgabe der Zone. */
  ttl: number | null;
  protection?: { change?: boolean };
  records: HetznerRecord[];
}

/** Ein Wert in seinem Satz, wörtlich wie Hetzner ihn führt. */
export interface RecordKey {
  name: string;
  type: string;
  value: string;
}

/** Ein Wert, wie er nach dem Schreiben dastehen soll. */
export interface ValueTarget extends RecordKey {
  comment: string | null;
  ttl: number | null;
}

export type RRSetAction =
  | 'add_records'
  | 'remove_records'
  | 'set_records'
  | 'update_records'
  | 'change_ttl';

/** Ein Aufruf `POST /zones/{zone}/rrsets/{name}/{type}/actions/{action}`. */
export interface RRSetStep {
  action: RRSetAction;
  name: string;
  type: string;
  body: Record<string, unknown>;
}

/** Arten, von denen ein Name nur einen Wert trägt. */
const SINGLE_VALUE_TYPES: readonly string[] = ['CNAME'];

/** Arten, deren Wert ein Hostname ist. */
const NAME_TYPES: readonly string[] = ['CNAME', 'NS'];

export function encodeRecordId(key: RecordKey): string {
  return Buffer.from(JSON.stringify([key.name, key.type, key.value]), 'utf8').toString('base64url');
}

export function decodeRecordId(id: string): RecordKey | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(id, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      parsed.every((part) => typeof part === 'string')
    ) {
      const [name, type, value] = parsed as [string, string, string];
      return { name, type, value };
    }
  } catch {
    // Keine Kennung von hier, etwa die eines Cloudflare-Eintrags.
  }
  return null;
}

const TXT_CHUNK = 255;

function isQuotedTxt(text: string): boolean {
  return text.length >= 2 && text.startsWith('"') && text.endsWith('"');
}

/**
 * Ein Text als TXT-Wert: in Anführungszeichen, ab 255 Zeichen in Stücke geteilt.
 *
 * Wer den Wert schon in dieser Form eingibt (aus einer Zonendatei kopiert),
 * bekommt ihn unverändert: ein zweites Paar Anführungszeichen darum wäre ein
 * anderer Text.
 */
export function formatTxt(text: string): string {
  if (isQuotedTxt(text)) return text;
  const chunks: string[] = [];
  for (let at = 0; at < text.length; at += TXT_CHUNK) chunks.push(text.slice(at, at + TXT_CHUNK));
  if (chunks.length === 0) chunks.push('');
  return chunks.map((chunk) => `"${chunk.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(' ');
}

/** Der Text eines TXT-Werts: die Stücke aneinander, ohne Anführungszeichen. */
export function parseTxt(value: string): string {
  if (!value.includes('"')) return value;
  let text = '';
  let quoted = false;
  for (let at = 0; at < value.length; at += 1) {
    const char = value[at];
    if (char === '\\' && at + 1 < value.length) {
      const decimal = /^\d{3}/.exec(value.slice(at + 1));
      if (decimal) {
        text += String.fromCharCode(Number(decimal[0]));
        at += 3;
      } else {
        text += value[at + 1];
        at += 1;
      }
    } else if (char === '"') {
      quoted = !quoted;
    } else if (quoted || !/\s/.test(char)) {
      text += char;
    }
  }
  return text;
}

/**
 * Ein Ziel als voller Name ohne Punkt.
 *
 * Ohne Punkt am Ende ist ein Ziel in einer Zonendatei relativ zur Zone, `@` ist
 * die Zone selbst. HAPM schreibt Ziele immer mit Punkt, diese Fälle kommen also
 * nur von Einträgen, die jemand anderes gesetzt hat.
 */
function absoluteTarget(target: string, zoneName: string): string {
  if (target === '@') return zoneName;
  if (target === '.') return target;
  if (target.endsWith('.')) return target.slice(0, -1);
  return `${target}.${zoneName}`;
}

function writtenTarget(target: string): string {
  return `${target.trim().replace(/\.+$/, '')}.`;
}

/** Aus dem Wert, wie Hetzner ihn führt, die Form, mit der HAPM rechnet. */
export function readValue(
  type: string,
  value: string,
  zoneName: string
): { content: string; priority: number | null } {
  if (NAME_TYPES.includes(type)) {
    return { content: absoluteTarget(value.trim(), zoneName), priority: null };
  }
  if (type === 'MX') {
    const parts = /^(\d+)\s+(\S+)$/.exec(value.trim());
    // Was nicht „Priorität Ziel" ist, wird gezeigt, wie es dasteht. Eine
    // erfundene Priorität wäre eine Aussage über den Eintrag.
    if (!parts) return { content: value, priority: null };
    return { content: absoluteTarget(parts[2], zoneName), priority: Number(parts[1]) };
  }
  if (type === 'TXT') return { content: parseTxt(value), priority: null };
  return { content: value, priority: null };
}

/** Aus der Eingabe der Oberfläche der Wert, wie Hetzner ihn führt. */
export function writeValue(type: string, content: string, priority: number | null): string {
  if (NAME_TYPES.includes(type)) return writtenTarget(content);
  if (type === 'MX') return `${priority ?? 0} ${writtenTarget(content)}`;
  if (type === 'TXT') return formatTxt(content);
  return content.trim();
}

/** Der Name eines Satzes aus dem vollen Namen: `@` oder der Teil vor der Zone. */
export function rrsetName(fqdn: string, zoneName: string): string {
  return recordName(fqdn, zoneName);
}

/**
 * Ein Satz als einzelne Einträge.
 *
 * `locked` trägt, was hier nicht angefasst wird: ein Satz, den jemand bei
 * Hetzner gegen Änderungen geschützt hat, der SOA, und die Nameserver der Zone
 * selbst. Die setzt Hetzner beim Anlegen der Zone, und ohne sie wird die Zone
 * nicht mehr ausgeliefert.
 */
export function rrsetToRecords(rrset: HetznerRRSet, zoneName: string): DnsRecord[] {
  const locked =
    rrset.protection?.change === true ||
    rrset.type === 'SOA' ||
    (rrset.type === 'NS' && rrset.name === '@');
  return rrset.records.map((record) => {
    const { content, priority } = readValue(rrset.type, record.value, zoneName);
    return {
      id: encodeRecordId({ name: rrset.name, type: rrset.type, value: record.value }),
      type: rrset.type,
      name: recordFqdn(rrset.name, zoneName),
      content,
      ttl: rrset.ttl ?? null,
      proxied: false,
      priority,
      comment: record.comment ? record.comment : null,
      locked,
    };
  });
}

/** Alle Sätze einer Zone als Einträge, nach Art und Name geordnet wie bei Cloudflare. */
export function rrsetsToRecords(rrsets: HetznerRRSet[], zoneName: string): DnsRecord[] {
  return rrsets
    .flatMap((rrset) => rrsetToRecords(rrset, zoneName))
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}

export function hasValue(rrset: HetznerRRSet | null, value: string): boolean {
  return rrset?.records.some((record) => record.value === value) ?? false;
}

function inSameSet(a: RecordKey, b: RecordKey): boolean {
  return a.name === b.name && a.type === b.type;
}

function written(next: ValueTarget): HetznerRecord {
  return next.comment ? { value: next.value, comment: next.comment } : { value: next.value };
}

/**
 * Warum sich `next` nicht schreiben lässt, oder `null`.
 *
 * `target` ist der Satz, in dem der Wert danach stehen soll, frisch gelesen.
 * `current` ist der Eintrag, der dabei geändert wird (`null` beim Anlegen).
 */
export function writeConflict(
  next: ValueTarget,
  target: HetznerRRSet | null,
  current: RecordKey | null
): Message | null {
  if (!target) return null;
  const moved = current === null || !inSameSet(current, next);
  if (hasValue(target, next.value) && (moved || current.value !== next.value)) {
    return msg('Ein Eintrag mit diesem Namen, dieser Art und diesem Wert steht dort bereits.');
  }
  if (moved && SINGLE_VALUE_TYPES.includes(next.type) && target.records.length > 0) {
    return msg('Unter diesem Namen steht bereits ein {type}-Eintrag, und ein Name trägt nur einen.', { type: next.type });
  }
  return null;
}

/**
 * Einen Wert anlegen.
 *
 * Steht der Satz schon, geht seine TTL mit: Hetzner verlangt beim Hinzufügen
 * dieselbe. Gewechselt wird sie danach, und nur, wenn jemand eine gewählt hat.
 * „Keine eigene TTL" heißt hier: so lassen, wie der Name sie hat, und nicht:
 * die der Nachbarn zurücksetzen.
 */
export function planCreate(next: ValueTarget, target: HetznerRRSet | null): RRSetStep[] {
  const ttl = target ? target.ttl : next.ttl;
  const steps: RRSetStep[] = [
    {
      action: 'add_records',
      name: next.name,
      type: next.type,
      body: { ...(ttl === null ? {} : { ttl }), records: [written(next)] },
    },
  ];
  if (target && next.ttl !== null && next.ttl !== target.ttl) {
    steps.push({ action: 'change_ttl', name: next.name, type: next.type, body: { ttl: next.ttl } });
  }
  return steps;
}

export function planDelete(current: RecordKey): RRSetStep[] {
  return [
    {
      action: 'remove_records',
      name: current.name,
      type: current.type,
      body: { records: [{ value: current.value }] },
    },
  ];
}

/**
 * Einen Wert ändern. Eine leere Liste heißt: es steht schon so da.
 *
 * `target` ist der Satz unter dem NEUEN Namen und der neuen Art. Bleiben beide
 * gleich, ist es der Satz, in dem `current` steht.
 */
export function planUpdate(
  current: RecordKey,
  next: ValueTarget,
  target: HetznerRRSet | null
): RRSetStep[] {
  if (!inSameSet(current, next)) return [...planCreate(next, target), ...planDelete(current)];

  const steps: RRSetStep[] = [];
  const at = { name: next.name, type: next.type };

  if (next.value !== current.value) {
    if (SINGLE_VALUE_TYPES.includes(next.type)) {
      steps.push({ action: 'set_records', ...at, body: { records: [written(next)] } });
    } else {
      const ttl = target?.ttl ?? null;
      steps.push(
        {
          action: 'add_records',
          ...at,
          body: { ...(ttl === null ? {} : { ttl }), records: [written(next)] },
        },
        ...planDelete(current)
      );
    }
  } else {
    const before = target?.records.find((record) => record.value === current.value);
    if ((before?.comment ?? '') !== (next.comment ?? '')) {
      steps.push({
        action: 'update_records',
        ...at,
        body: { records: [{ value: next.value, comment: next.comment ?? '' }] },
      });
    }
  }

  if (target && next.ttl !== target.ttl) {
    steps.push({ action: 'change_ttl', ...at, body: { ttl: next.ttl } });
  }
  return steps;
}
