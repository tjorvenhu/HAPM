/**
 * DNS-Nachrichten bauen und lesen, samt TSIG (RFC 1035, 2136, 8945). Rein und
 * ohne Netz: was auf die Leitung geht, lässt sich hier Byte für Byte
 * nachrechnen (`tests/dns/dns-wire.test.ts`).
 *
 * ── Warum es das gibt, obwohl `nsupdate` im Abbild liegt ──
 *
 * acme.sh ruft `nsupdate` selbst auf und braucht dafür eine Schlüsseldatei.
 * HAPM selbst (Zone prüfen, den Eintrag eines Ziels setzen) spricht den
 * Nameserver von hier aus an: das Geheimnis geht dann durch kein Kommando und
 * liegt für HAPMs eigene Aufrufe in keiner Datei, die Antwort wird geprüft und
 * nicht aus Text gelesen, und es läuft auch dort, wo es kein `nsupdate` gibt
 * (`pnpm dev`, die Tests).
 *
 * ── Was hier nicht steht ──
 *
 * Kein DNSSEC, kein EDNS, kein AXFR, kein GSS-TSIG (das Verfahren von Windows
 * DNS): ein Nameserver, der nur das annimmt, ist über RFC 2136 mit TSIG nicht
 * erreichbar.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { TsigAlgorithm } from './access';

export const TYPE = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  TSIG: 250,
  ANY: 255,
} as const;

export const CLASS = { IN: 1, NONE: 254, ANY: 255 } as const;

export const OPCODE = { QUERY: 0, UPDATE: 5 } as const;

export const RCODE = {
  NOERROR: 0,
  FORMERR: 1,
  SERVFAIL: 2,
  NXDOMAIN: 3,
  NOTIMP: 4,
  REFUSED: 5,
  YXDOMAIN: 6,
  YXRRSET: 7,
  NXRRSET: 8,
  NOTAUTH: 9,
  NOTZONE: 10,
} as const;

/** Die Fehler im TSIG-Eintrag einer Antwort (RFC 8945, 5.2 bis 5.4). */
export const TSIG_ERROR = { BADSIG: 16, BADKEY: 17, BADTIME: 18, BADTRUNC: 22 } as const;

const TYPE_NAMES = new Map<number, string>(
  Object.entries(TYPE).map(([name, code]) => [code, name])
);

export function typeName(code: number): string {
  return TYPE_NAMES.get(code) ?? `TYPE${code}`;
}

export function typeCode(name: string): number | null {
  const code = (TYPE as Record<string, number>)[name.toUpperCase()];
  return code === undefined ? null : code;
}

const HASH: Record<TsigAlgorithm, string> = {
  'hmac-sha256': 'sha256',
  'hmac-sha384': 'sha384',
  'hmac-sha512': 'sha512',
};

export interface TsigKey {
  name: string;
  algorithm: TsigAlgorithm;
  secret: Buffer;
}

/* ── Namen ── */

/** Ein Name als Folge von Labels, ohne Kompression. `.` und leer sind die Wurzel. */
export function encodeName(name: string): Buffer {
  const trimmed = name.replace(/\.$/, '');
  if (trimmed === '') return Buffer.from([0]);
  const parts: Buffer[] = [];
  for (const label of trimmed.split('.')) {
    const bytes = Buffer.from(label, 'latin1');
    if (bytes.length === 0 || bytes.length > 63) throw new Error(`Ungültiger DNS-Name: ${name}`);
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0]));
  const wire = Buffer.concat(parts);
  if (wire.length > 255) throw new Error(`DNS-Name zu lang: ${name}`);
  return wire;
}

/**
 * Einen Namen lesen, auch einen gekürzten (Zeiger auf eine frühere Stelle der
 * Nachricht). `next` ist die Stelle hinter dem Namen, wie er an `offset` steht.
 */
export function decodeName(message: Buffer, offset: number): { name: string; next: number } {
  const labels: string[] = [];
  let at = offset;
  let next = -1;
  // Ein Zeiger auf einen Zeiger auf sich selbst wäre eine Endlosschleife.
  for (let jumps = 0; jumps < 64; ) {
    if (at >= message.length) throw new Error('DNS-Antwort bricht mitten in einem Namen ab.');
    const length = message[at];
    if (length === 0) {
      if (next < 0) next = at + 1;
      return { name: labels.join('.'), next };
    }
    if ((length & 0xc0) === 0xc0) {
      if (at + 1 >= message.length) throw new Error('DNS-Antwort bricht mitten in einem Namen ab.');
      if (next < 0) next = at + 2;
      at = ((length & 0x3f) << 8) | message[at + 1];
      jumps += 1;
      continue;
    }
    if (length > 63 || at + 1 + length > message.length) throw new Error('Ungültiger Name in der DNS-Antwort.');
    labels.push(message.subarray(at + 1, at + 1 + length).toString('latin1'));
    at += 1 + length;
  }
  throw new Error('Ungültiger Name in der DNS-Antwort.');
}

/** Wie TSIG und der Vergleich von Namen ihn brauchen: klein, ohne Punkt am Ende. */
export function canonicalName(name: string): string {
  return name.trim().toLowerCase().replace(/\.+$/, '');
}

/* ── Adressen ── */

function ipv4Bytes(address: string): Buffer | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  if (bytes.some((byte) => Number.isNaN(byte) || byte > 255)) return null;
  return Buffer.from(bytes);
}

function ipv6Bytes(address: string): Buffer | null {
  let value = address.trim().toLowerCase();
  const mapped = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(value);
  if (mapped) {
    const tail = ipv4Bytes(mapped[2]);
    if (!tail) return null;
    value = `${mapped[1]}${tail.readUInt16BE(0).toString(16)}:${tail.readUInt16BE(2).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const gap = 8 - head.length - tail.length;
  if (halves.length === 1 ? gap !== 0 : gap < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? gap : 0).fill('0'), ...tail];
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  const bytes = Buffer.alloc(16);
  groups.forEach((group, index) => bytes.writeUInt16BE(parseInt(group, 16), index * 2));
  return bytes;
}

/** Sechzehn Bytes als Adresse, die längste Folge von Nullgruppen gekürzt (RFC 5952). */
function ipv6Text(bytes: Buffer): string {
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i));
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i += 1;
      continue;
    }
    let end = i;
    while (end < 8 && groups[end] === 0) end += 1;
    if (end - i > bestLength) {
      bestStart = i;
      bestLength = end - i;
    }
    i = end;
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestLength < 2) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLength).join(':')}`;
}

/* ── Inhalte (RDATA) ── */

/** Ein TXT-Text in Stücken zu höchstens 255 Bytes, wie er in der Zone steht. */
function txtRdata(text: string): Buffer {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length === 0) return Buffer.from([0]);
  const parts: Buffer[] = [];
  for (let at = 0; at < bytes.length; at += 255) {
    const piece = bytes.subarray(at, at + 255);
    parts.push(Buffer.from([piece.length]), piece);
  }
  return Buffer.concat(parts);
}

/**
 * Der Inhalt eines Eintrags in der Form, in der er geschrieben wird: ohne
 * gekürzte Namen. Nur die Arten, die HAPM schreibt oder zum Entfernen wieder
 * benennen muss.
 */
export function encodeRdata(type: number, content: string, priority?: number | null): Buffer {
  switch (type) {
    case TYPE.A: {
      const bytes = ipv4Bytes(content.trim());
      if (!bytes) throw new Error(`Keine IPv4-Adresse: ${content}`);
      return bytes;
    }
    case TYPE.AAAA: {
      const bytes = ipv6Bytes(content);
      if (!bytes) throw new Error(`Keine IPv6-Adresse: ${content}`);
      return bytes;
    }
    case TYPE.CNAME:
    case TYPE.NS:
      return encodeName(content);
    case TYPE.MX: {
      const head = Buffer.alloc(2);
      head.writeUInt16BE(priority ?? 0);
      return Buffer.concat([head, encodeName(content)]);
    }
    case TYPE.TXT:
      return txtRdata(content);
    default:
      throw new Error(`Die Eintragsart ${typeName(type)} schreibt HAPM nicht.`);
  }
}

export interface WireRecord {
  name: string;
  type: number;
  class: number;
  ttl: number;
  /** Der Inhalt ohne gekürzte Namen: so lässt er sich in einer Änderung wieder benennen. */
  rdata: Buffer;
  /** Der Inhalt als Text, für die Arten, die HAPM liest. Sonst `null`. */
  content: string | null;
  /** Nur MX. */
  priority: number | null;
}

/** SOA als Text: nur der Name des ersten Nameservers, mehr braucht hier niemand. */
function readRdata(
  message: Buffer,
  type: number,
  start: number,
  length: number
): Pick<WireRecord, 'rdata' | 'content' | 'priority'> {
  const raw = Buffer.from(message.subarray(start, start + length));
  switch (type) {
    case TYPE.A:
      return { rdata: raw, content: length === 4 ? [...raw].join('.') : null, priority: null };
    case TYPE.AAAA:
      return { rdata: raw, content: length === 16 ? ipv6Text(raw) : null, priority: null };
    case TYPE.CNAME:
    case TYPE.NS: {
      const { name } = decodeName(message, start);
      return { rdata: encodeName(name), content: name, priority: null };
    }
    case TYPE.MX: {
      const priority = message.readUInt16BE(start);
      const { name } = decodeName(message, start + 2);
      return { rdata: encodeRdata(TYPE.MX, name, priority), content: name, priority };
    }
    case TYPE.TXT: {
      const pieces: Buffer[] = [];
      for (let at = 0; at < raw.length; ) {
        const size = raw[at];
        pieces.push(raw.subarray(at + 1, at + 1 + size));
        at += 1 + size;
      }
      return { rdata: raw, content: Buffer.concat(pieces).toString('utf8'), priority: null };
    }
    case TYPE.SOA: {
      const { name } = decodeName(message, start);
      return { rdata: raw, content: name, priority: null };
    }
    default:
      return { rdata: raw, content: null, priority: null };
  }
}

/* ── Nachrichten ── */

export interface WriteRecord {
  name: string;
  type: number;
  class: number;
  ttl: number;
  rdata: Buffer;
}

export interface MessageInput {
  id: number;
  opcode: number;
  /** Bei einer Abfrage die Frage, bei einer Änderung die Zone (Art SOA). */
  question: { name: string; type: number; class: number };
  /** Abfrage: leer. Änderung: die Vorbedingungen. */
  answer?: WriteRecord[];
  /** Abfrage: leer. Änderung: was geändert wird. */
  authority?: WriteRecord[];
}

function recordWire(record: WriteRecord): Buffer {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(record.type, 0);
  head.writeUInt16BE(record.class, 2);
  head.writeUInt32BE(record.ttl >>> 0, 4);
  head.writeUInt16BE(record.rdata.length, 8);
  return Buffer.concat([encodeName(record.name), head, record.rdata]);
}

/** Ohne Rekursion: gefragt wird der Nameserver, der die Zone führt, und nur er. */
export function encodeMessage(input: MessageInput): Buffer {
  const answer = input.answer ?? [];
  const authority = input.authority ?? [];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(input.id & 0xffff, 0);
  header.writeUInt16BE((input.opcode & 0x0f) << 11, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answer.length, 6);
  header.writeUInt16BE(authority.length, 8);
  header.writeUInt16BE(0, 10);
  const question = Buffer.alloc(4);
  question.writeUInt16BE(input.question.type, 0);
  question.writeUInt16BE(input.question.class, 2);
  return Buffer.concat([
    header,
    encodeName(input.question.name),
    question,
    ...answer.map(recordWire),
    ...authority.map(recordWire),
  ]);
}

export interface DecodedMessage {
  id: number;
  opcode: number;
  rcode: number;
  /** Die Antwort kommt von einem Nameserver, der die Zone selbst führt. */
  authoritative: boolean;
  truncated: boolean;
  /** Die Frage, bei einer Änderung die Zone. `null`, wenn die Nachricht keine trägt. */
  question: { name: string; type: number; class: number } | null;
  answer: WireRecord[];
  authority: WireRecord[];
  additional: WireRecord[];
  /** Wo der letzte Eintrag der Nachricht beginnt. TSIG steht immer dort. */
  lastRecordOffset: number | null;
}

export function decodeMessage(message: Buffer): DecodedMessage {
  if (message.length < 12) throw new Error('DNS-Antwort ist kürzer als ihr Kopf.');
  const flags = message.readUInt16BE(2);
  const counts = [4, 6, 8, 10].map((at) => message.readUInt16BE(at));
  let at = 12;
  let question: DecodedMessage['question'] = null;
  for (let i = 0; i < counts[0]; i += 1) {
    const { name, next } = decodeName(message, at);
    if (next + 4 > message.length) throw new Error('DNS-Antwort bricht mitten in der Frage ab.');
    if (i === 0) question = { name, type: message.readUInt16BE(next), class: message.readUInt16BE(next + 2) };
    at = next + 4;
  }

  let lastRecordOffset: number | null = null;
  const section = (count: number): WireRecord[] => {
    const records: WireRecord[] = [];
    for (let i = 0; i < count; i += 1) {
      lastRecordOffset = at;
      const { name, next } = decodeName(message, at);
      if (next + 10 > message.length) throw new Error('DNS-Antwort bricht mitten in einem Eintrag ab.');
      const type = message.readUInt16BE(next);
      const length = message.readUInt16BE(next + 8);
      const start = next + 10;
      if (start + length > message.length) throw new Error('DNS-Antwort bricht mitten in einem Eintrag ab.');
      records.push({
        name,
        type,
        class: message.readUInt16BE(next + 2),
        ttl: message.readUInt32BE(next + 4),
        // TSIG wird nicht hier gelesen, sondern in `verifyTsig`.
        ...(type === TYPE.TSIG
          ? { rdata: Buffer.from(message.subarray(start, start + length)), content: null, priority: null }
          : readRdata(message, type, start, length)),
      });
      at = start + length;
    }
    return records;
  };

  const answer = section(counts[1]);
  const authority = section(counts[2]);
  const additional = section(counts[3]);
  return {
    id: message.readUInt16BE(0),
    opcode: (flags >> 11) & 0x0f,
    rcode: flags & 0x0f,
    authoritative: (flags & 0x0400) !== 0,
    truncated: (flags & 0x0200) !== 0,
    question,
    answer,
    authority,
    additional,
    lastRecordOffset,
  };
}

/* ── TSIG ── */

/** Wie lange Absender und Empfänger in der Uhrzeit auseinanderliegen dürfen. */
const FUDGE_SECONDS = 300;

function uint48(value: number): Buffer {
  const bytes = Buffer.alloc(6);
  bytes.writeUInt16BE(Math.floor(value / 0x1_0000_0000), 0);
  bytes.writeUInt32BE(value >>> 0, 2);
  return bytes;
}

function uint16(value: number): Buffer {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value & 0xffff);
  return bytes;
}

/** Die Angaben, die außer der Nachricht in die Unterschrift eingehen (RFC 8945, 4.3.3). */
function tsigVariables(
  key: Pick<TsigKey, 'name' | 'algorithm'>,
  time: number,
  fudge: number,
  error: number,
  other: Buffer
): Buffer {
  return Buffer.concat([
    encodeName(canonicalName(key.name)),
    uint16(CLASS.ANY),
    Buffer.alloc(4),
    encodeName(key.algorithm),
    uint48(time),
    uint16(fudge),
    uint16(error),
    uint16(other.length),
    other,
  ]);
}

export interface SignedMessage {
  wire: Buffer;
  /** Geht in die Prüfung der Antwort ein. */
  mac: Buffer;
}

/** Hängt den TSIG-Eintrag an und zählt ihn im Kopf mit. `time` in Sekunden. */
export function signMessage(message: Buffer, key: TsigKey, time: number): SignedMessage {
  const mac = createHmac(HASH[key.algorithm], key.secret)
    .update(message)
    .update(tsigVariables(key, time, FUDGE_SECONDS, 0, Buffer.alloc(0)))
    .digest();

  const rdata = Buffer.concat([
    encodeName(key.algorithm),
    uint48(time),
    uint16(FUDGE_SECONDS),
    uint16(mac.length),
    mac,
    message.subarray(0, 2),
    uint16(0),
    uint16(0),
  ]);
  const wire = Buffer.concat([
    message,
    recordWire({ name: canonicalName(key.name), type: TYPE.TSIG, class: CLASS.ANY, ttl: 0, rdata }),
  ]);
  wire.writeUInt16BE(message.readUInt16BE(10) + 1, 10);
  return { wire, mac };
}

export type TsigVerdict =
  | { ok: true }
  /** `unsigned`: die Antwort trägt keinen TSIG-Eintrag. `error`: der Nameserver nennt einen Fehler. */
  | { ok: false; reason: 'unsigned' | 'error' | 'mismatch' | 'time'; error: number | null };

/**
 * Prüft die Unterschrift einer Antwort gegen den Schlüssel und die
 * Unterschrift der Anfrage (RFC 8945, 5.3). Ohne diese Prüfung könnte jeder im
 * Netz eine Antwort unterschieben, die „gespeichert" sagt.
 */
export function verifyTsig(response: Buffer, key: TsigKey, requestMac: Buffer, now: number): TsigVerdict {
  const decoded = decodeMessage(response);
  const last = decoded.additional[decoded.additional.length - 1];
  if (!last || last.type !== TYPE.TSIG || decoded.lastRecordOffset === null) {
    return { ok: false, reason: 'unsigned', error: null };
  }

  const rdata = last.rdata;
  let at = decodeName(rdata, 0).next;
  const algorithm = canonicalName(decodeName(rdata, 0).name);
  const time = rdata.readUInt16BE(at) * 0x1_0000_0000 + rdata.readUInt32BE(at + 2);
  const fudge = rdata.readUInt16BE(at + 6);
  const macSize = rdata.readUInt16BE(at + 8);
  at += 10;
  const mac = rdata.subarray(at, at + macSize);
  at += macSize;
  const originalId = rdata.subarray(at, at + 2);
  const error = rdata.readUInt16BE(at + 2);
  const otherLength = rdata.readUInt16BE(at + 4);
  const other = rdata.subarray(at + 6, at + 6 + otherLength);

  if (error !== 0) return { ok: false, reason: 'error', error };
  if (canonicalName(last.name) !== canonicalName(key.name) || algorithm !== key.algorithm) {
    return { ok: false, reason: 'mismatch', error: null };
  }

  // Unterschrieben ist die Nachricht, wie sie vor dem Anhängen aussah: ohne
  // den TSIG-Eintrag, mit einem Eintrag weniger im Kopf und der ersten Kennung.
  const body = Buffer.from(response.subarray(0, decoded.lastRecordOffset));
  originalId.copy(body, 0);
  body.writeUInt16BE(response.readUInt16BE(10) - 1, 10);

  const expected = createHmac(HASH[key.algorithm], key.secret)
    .update(uint16(requestMac.length))
    .update(requestMac)
    .update(body)
    .update(tsigVariables(key, time, fudge, error, other))
    .digest();
  if (expected.length !== mac.length || !timingSafeEqual(expected, mac)) {
    return { ok: false, reason: 'mismatch', error: null };
  }
  if (Math.abs(now - time) > fudge) return { ok: false, reason: 'time', error: null };
  return { ok: true };
}
