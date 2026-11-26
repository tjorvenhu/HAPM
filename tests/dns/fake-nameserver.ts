import { createHmac } from 'node:crypto';
import {
  CLASS,
  OPCODE,
  RCODE,
  TSIG_ERROR,
  TYPE,
  canonicalName,
  decodeMessage,
  encodeMessage,
  encodeName,
  encodeRdata,
  signMessage,
  type DecodedMessage,
  type TsigKey,
  type WriteRecord,
} from '@/lib/dns/dns-wire';
import type { DnsExchange } from '@/lib/dns/rfc2136';

/**
 * Ein Nameserver im Speicher, der Abfragen und Änderungen (RFC 2136) so
 * beantwortet, wie es die RFCs beschreiben, und jede Antwort mit TSIG
 * unterschreibt. Nachgestellt ist die Leitung, nicht eine Bibliothek: was
 * `lib/dns/rfc2136.ts` hinausschickt, wird hier Byte für Byte gelesen.
 *
 * Die Unterschrift der Antwort rechnet diese Datei selbst (`signResponse`),
 * nicht über `verifyTsig`: sonst prüfte der Test die Funktion gegen sich.
 * Gegen ein echtes BIND läuft dasselbe in `pnpm dns:verify`.
 */

export interface FakeRecord {
  name: string;
  type: number;
  ttl: number;
  rdata: Buffer;
}

export interface FakeZone {
  name: string;
  records: FakeRecord[];
  /** Die Schlüssel, die die Zone ändern dürfen. */
  writers: string[];
}

const HASH = { 'hmac-sha256': 'sha256', 'hmac-sha384': 'sha384', 'hmac-sha512': 'sha512' } as const;

function uint16(value: number): Buffer {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value & 0xffff);
  return bytes;
}

function uint48(value: number): Buffer {
  const bytes = Buffer.alloc(6);
  bytes.writeUInt16BE(Math.floor(value / 0x1_0000_0000), 0);
  bytes.writeUInt32BE(value >>> 0, 2);
  return bytes;
}

function tsigRecord(key: Pick<TsigKey, 'name' | 'algorithm'>, time: number, mac: Buffer, id: Buffer, error: number): Buffer {
  const rdata = Buffer.concat([encodeName(key.algorithm), uint48(time), uint16(300), uint16(mac.length), mac, id, uint16(error), uint16(0)]);
  const head = Buffer.alloc(10);
  head.writeUInt16BE(TYPE.TSIG, 0);
  head.writeUInt16BE(CLASS.ANY, 2);
  head.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([encodeName(canonicalName(key.name)), head, rdata]);
}

/** RFC 8945, 5.3: die Unterschrift der Anfrage geht der Antwort voran. */
function signResponse(message: Buffer, key: TsigKey, requestMac: Buffer, time: number): Buffer {
  const variables = Buffer.concat([
    encodeName(canonicalName(key.name)),
    uint16(CLASS.ANY),
    Buffer.alloc(4),
    encodeName(key.algorithm),
    uint48(time),
    uint16(300),
    uint16(0),
    uint16(0),
  ]);
  const mac = createHmac(HASH[key.algorithm], key.secret)
    .update(uint16(requestMac.length))
    .update(requestMac)
    .update(message)
    .update(variables)
    .digest();
  const wire = Buffer.concat([message, tsigRecord(key, time, mac, message.subarray(0, 2), 0)]);
  wire.writeUInt16BE(message.readUInt16BE(10) + 1, 10);
  return wire;
}

export function rr(name: string, type: keyof typeof TYPE, content: string, ttl = 300): FakeRecord {
  return { name: canonicalName(name), type: TYPE[type], ttl, rdata: encodeRdata(TYPE[type], content) };
}

export class FakeNameserver {
  readonly zones: FakeZone[] = [];
  readonly keys = new Map<string, TsigKey>();
  /** Jede gelesene Anfrage, für Prüfungen der Reihenfolge. */
  readonly seen: DecodedMessage[] = [];
  /** Die Uhr des Nameservers in Sekunden. */
  now = 1_800_000_000;
  /** Antwortet ohne Unterschrift, als verstünde er kein TSIG. */
  unsigned = false;
  /** Unterschreibt mit einem falschen Schlüssel: eine untergeschobene Antwort. */
  forge = false;
  /** Wertet die Vorbedingungen einer Änderung nicht aus. */
  ignorePrerequisites = false;

  addKey(key: TsigKey): this {
    this.keys.set(canonicalName(key.name), key);
    return this;
  }

  addZone(name: string, writers: string[], records: FakeRecord[] = []): FakeZone {
    const zone = { name: canonicalName(name), writers, records: [rr(name, 'NS', `ns1.${name}`), ...records] };
    this.zones.push(zone);
    return zone;
  }

  readonly exchange: DnsExchange = async (_server, _port, wire) => this.answer(wire);

  private zoneOf(name: string): FakeZone | null {
    const value = canonicalName(name);
    let best: FakeZone | null = null;
    for (const zone of this.zones) {
      if (value !== zone.name && !value.endsWith(`.${zone.name}`)) continue;
      if (!best || zone.name.length > best.name.length) best = zone;
    }
    return best;
  }

  private soa(zone: FakeZone): WriteRecord {
    const rdata = Buffer.concat([encodeName(`ns1.${zone.name}`), encodeName(`hostmaster.${zone.name}`), Buffer.alloc(20)]);
    return { name: zone.name, type: TYPE.SOA, class: CLASS.IN, ttl: 300, rdata };
  }

  private reply(
    request: DecodedMessage,
    rcode: number,
    sections: { answer?: WriteRecord[]; authority?: WriteRecord[] } = {},
    authoritative = true
  ): Buffer {
    const message = encodeMessage({
      id: request.id,
      opcode: request.opcode,
      question: request.question ?? { name: '.', type: TYPE.SOA, class: CLASS.IN },
      answer: sections.answer,
      authority: sections.authority,
    });
    message.writeUInt16BE(0x8000 | (request.opcode << 11) | (authoritative ? 0x0400 : 0) | rcode, 2);
    return message;
  }

  private answer(wire: Buffer): Buffer {
    const request = decodeMessage(wire);
    this.seen.push(request);
    const tsig = request.additional[request.additional.length - 1];
    if (!tsig || tsig.type !== TYPE.TSIG || request.lastRecordOffset === null) {
      return this.reply(request, RCODE.REFUSED);
    }

    // Die Anfrage, wie sie vor dem Unterschreiben aussah.
    const body = Buffer.from(wire.subarray(0, request.lastRecordOffset));
    body.writeUInt16BE(wire.readUInt16BE(10) - 1, 10);
    const algorithmEnd = (() => {
      let at = 0;
      while (tsig.rdata[at] !== 0) at += 1 + tsig.rdata[at];
      return at + 1;
    })();
    const time = tsig.rdata.readUInt16BE(algorithmEnd) * 0x1_0000_0000 + tsig.rdata.readUInt32BE(algorithmEnd + 2);
    const macSize = tsig.rdata.readUInt16BE(algorithmEnd + 8);
    const requestMac = tsig.rdata.subarray(algorithmEnd + 10, algorithmEnd + 10 + macSize);

    const key = this.keys.get(canonicalName(tsig.name));
    const refuse = (error: number) => {
      // RFC 8945, 5.2: ohne gültigen Schlüssel NOTAUTH, und die Antwort ist nicht unterschrieben.
      const message = this.reply(request, RCODE.NOTAUTH);
      const named = { name: tsig.name, algorithm: key?.algorithm ?? ('hmac-sha256' as const) };
      const signed = Buffer.concat([message, tsigRecord(named, this.now, Buffer.alloc(0), message.subarray(0, 2), error)]);
      signed.writeUInt16BE(1, 10);
      return signed;
    };
    if (!key) return refuse(TSIG_ERROR.BADKEY);
    if (!signMessage(body, key, time).mac.equals(requestMac)) return refuse(TSIG_ERROR.BADSIG);
    if (Math.abs(this.now - time) > 300) return refuse(TSIG_ERROR.BADTIME);

    const response = request.opcode === OPCODE.UPDATE ? this.update(request, key) : this.query(request);
    if (this.unsigned) return response;
    const signer = this.forge ? { ...key, secret: Buffer.from('ein-ganz-anderes-geheimnis') } : key;
    return signResponse(response, signer, requestMac, this.now);
  }

  private at(zone: FakeZone, name: string, type?: number): FakeRecord[] {
    return zone.records.filter((record) => record.name === name && (type === undefined || record.type === type));
  }

  private query(request: DecodedMessage): Buffer {
    const question = request.question!;
    const name = canonicalName(question.name);
    const zone = this.zoneOf(name);
    if (!zone) return this.reply(request, RCODE.REFUSED, {}, false);
    const negative = { authority: [this.soa(zone)] };

    if (question.type === TYPE.SOA && name === zone.name) return this.reply(request, RCODE.NOERROR, { answer: [this.soa(zone)] });

    const toAnswer = (owner: string, records: FakeRecord[]): WriteRecord[] =>
      records.map((record) => ({ name: owner, type: record.type, class: CLASS.IN, ttl: record.ttl, rdata: record.rdata }));

    if (this.at(zone, name).length > 0) {
      const exact = this.at(zone, name, question.type);
      return this.reply(request, RCODE.NOERROR, exact.length > 0 ? { answer: toAnswer(name, exact) } : negative);
    }
    // Ein Stern beantwortet jeden Namen darunter, und die Antwort trägt den erfragten.
    const parent = name.includes('.') ? name.slice(name.indexOf('.') + 1) : '';
    const star = this.at(zone, `*.${parent}`);
    if (star.length > 0) {
      const matched = star.filter((record) => record.type === question.type);
      return this.reply(request, RCODE.NOERROR, matched.length > 0 ? { answer: toAnswer(name, matched) } : negative);
    }
    return this.reply(request, RCODE.NXDOMAIN, negative);
  }

  private update(request: DecodedMessage, key: TsigKey): Buffer {
    const zone = this.zones.find((entry) => entry.name === canonicalName(request.question!.name));
    if (!zone) return this.reply(request, RCODE.NOTAUTH);
    if (!zone.writers.includes(canonicalName(key.name))) return this.reply(request, RCODE.REFUSED);

    for (const condition of this.ignorePrerequisites ? [] : request.answer) {
      const name = canonicalName(condition.name);
      const present =
        condition.type === TYPE.ANY ? this.at(zone, name).length > 0 : this.at(zone, name, condition.type).length > 0;
      if (condition.class === CLASS.ANY && !present) {
        return this.reply(request, condition.type === TYPE.ANY ? RCODE.NXDOMAIN : RCODE.NXRRSET);
      }
      if (condition.class === CLASS.NONE && present) {
        return this.reply(request, condition.type === TYPE.ANY ? RCODE.YXDOMAIN : RCODE.YXRRSET);
      }
    }

    for (const change of request.authority) {
      const name = canonicalName(change.name);
      if (change.class === CLASS.NONE) {
        zone.records = zone.records.filter(
          (record) => !(record.name === name && record.type === change.type && record.rdata.equals(change.rdata))
        );
      } else if (change.class === CLASS.ANY) {
        zone.records = zone.records.filter((record) => !(record.name === name && record.type === change.type));
      } else {
        // RFC 2136, 3.4.2.2: ein CNAME neben anderen Daten (und umgekehrt) wird still übergangen.
        const others = this.at(zone, name).filter((record) => record.type !== change.type);
        const clash = change.type === TYPE.CNAME ? others.length > 0 : others.some((record) => record.type === TYPE.CNAME);
        if (clash) continue;
        if (this.at(zone, name, change.type).some((record) => record.rdata.equals(change.rdata))) continue;
        // Die TTL gehört dem Namen samt Art: die neue gilt für alle seine Werte.
        for (const record of this.at(zone, name, change.type)) record.ttl = change.ttl;
        zone.records.push({ name, type: change.type, ttl: change.ttl, rdata: change.rdata });
      }
    }
    return this.reply(request, RCODE.NOERROR);
  }
}
