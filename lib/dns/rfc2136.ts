/**
 * Ein eigener Nameserver (BIND und andere) über RFC 2136: Änderungen als
 * DNS-UPDATE, jede Nachricht mit TSIG unterschrieben. Die EINE Stelle, an der
 * eine Verbindung dorthin entsteht.
 *
 * ── Was dieser Anbieter nicht kann, und was stattdessen geschieht ──
 *
 * Er zählt nichts auf. Welche Zonen ein Schlüssel ändern darf, verrät der
 * Nameserver nicht, und alle Einträge einer Zone gäbe es nur über einen
 * Zonentransfer, den die wenigsten für einen Update-Schlüssel freigeben.
 * Deshalb:
 *
 * - **Die Zone wird gesucht, nicht gelistet** (`findZone`): gefragt wird nach
 *   dem SOA der Domain und dann ihrer Eltern, bis der Nameserver einen als
 *   seinen eigenen beantwortet (Antwort mit `AA`). Eine Verweisung auf andere
 *   Nameserver heißt: dieser führt die Domain nicht.
 * - **Gelesen wird gezielt**: je Name die Arten, die unter einem Namen üblich
 *   sind (CNAME, A, AAAA, TXT, MX, NS). `NXDOMAIN` auf die erste Frage spart
 *   die übrigen.
 * - **Ob ein Name frei ist, entscheidet der Nameserver beim Schreiben.** Ein
 *   CNAME entsteht mit der Vorbedingung „unter dem Namen steht nichts"
 *   (RFC 2136, 2.4.5). Ohne sie nimmt ein Nameserver einen CNAME neben anderen
 *   Daten an und wirft ihn still weg (3.4.2.2), und HAPM meldete einen
 *   Eintrag, den es nicht gibt. Nach jeder Änderung wird nachgelesen.
 *
 * ── Ein Stern in der Zone antwortet für jeden Namen ──
 *
 * Steht `*.example.org` in der Zone, beantwortet der Nameserver auch
 * `app.example.org` daraus, und die Antwort trägt den erfragten Namen. Von
 * einem echten Eintrag ist sie nicht zu unterscheiden. Deshalb die Gegenprobe
 * (`synthesized`): antwortet ein erfundener Nachbarname genauso, wird der
 * Nameserver gefragt, ob es den Namen wirklich gibt, mit einer Änderung, die
 * nur aus der Vorbedingung „der Name ist belegt" besteht und nichts ändert.
 *
 * ── Die Antwort wird geprüft ──
 *
 * Jede Antwort muss mit demselben Schlüssel unterschrieben sein
 * (`verifyTsig`). Eine Antwort ohne gültige Unterschrift ist ein Fehler und
 * kein „gespeichert".
 *
 * Gesprochen wird über TCP: eine Änderung samt Unterschrift passt nicht sicher
 * in ein UDP-Paket, und ein Weg statt zwei ist einer weniger zum Suchen.
 * acme.sh ruft für die Challenge `nsupdate` auf, und das nimmt UDP und TCP.
 */

import { connect } from 'node:net';
import { randomBytes, randomInt } from 'node:crypto';
import { ApiError } from '../api';
import { msg, type Message } from '../i18n';
import { DEFAULT_DNS_PORT, readRfc2136Access, type Rfc2136Access } from './access';
import { DnsUnreachableError } from './errors';
import {
  CLASS,
  OPCODE,
  RCODE,
  TSIG_ERROR,
  TYPE,
  canonicalName,
  decodeMessage,
  encodeMessage,
  encodeRdata,
  signMessage,
  typeCode,
  typeName,
  verifyTsig,
  type DecodedMessage,
  type MessageInput,
  type TsigKey,
  type TsigVerdict,
  type WireRecord,
  type WriteRecord,
} from './dns-wire';
import type { DnsRecord } from './records';
import type { DnsProvider, ProviderZone, RecordWrite, ZoneRef } from './provider';

const TIMEOUT_MS = 10_000;

/** Die TTL eines neuen Eintrags, wenn der Name noch keine hat und keine genannt ist. */
export const RFC2136_DEFAULT_TTL = 3600;

/** Was unter einem Namen gelesen wird. CNAME zuerst: seine Antwort entscheidet, ob es den Namen gibt. */
const READ_TYPES = [TYPE.CNAME, TYPE.A, TYPE.AAAA, TYPE.TXT, TYPE.MX, TYPE.NS] as const;

/** Was HAPM schreibt. */
const WRITE_TYPES = new Set<number>([TYPE.A, TYPE.AAAA, TYPE.CNAME, TYPE.TXT]);

/** Eine Anfrage hin, eine Antwort zurück. Im Test ein nachgestellter Nameserver. */
export type DnsExchange = (server: string, port: number, message: Buffer) => Promise<Buffer>;

/** DNS über TCP: zwei Bytes Länge, dann die Nachricht (RFC 1035, 4.2.2). */
export const tcpExchange: DnsExchange = (server, port, message) =>
  new Promise<Buffer>((resolve, reject) => {
    const socket = connect({ host: server, port });
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (error: Error | null, value?: Buffer) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (error || !value) reject(error ?? new Error('Keine Antwort'));
      else resolve(value);
    };
    socket.setTimeout(TIMEOUT_MS, () => {
      const error = new Error('Zeitüberschreitung');
      error.name = 'TimeoutError';
      finish(error);
    });
    socket.on('connect', () => {
      const head = Buffer.alloc(2);
      head.writeUInt16BE(message.length);
      socket.write(Buffer.concat([head, message]));
    });
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      const all = Buffer.concat(chunks);
      if (all.length < 2) return;
      const size = all.readUInt16BE(0);
      if (all.length >= 2 + size) finish(null, all.subarray(2, 2 + size));
    });
    socket.on('error', (error) => finish(error));
    socket.on('close', () => finish(new Error('Die Verbindung wurde geschlossen, bevor die Antwort vollständig war.')));
  });

function serverLabel(access: Rfc2136Access): string {
  return access.port === DEFAULT_DNS_PORT ? access.server : `${access.server}:${access.port}`;
}

function rcodeName(code: number): string {
  return Object.entries(RCODE).find(([, value]) => value === code)?.[0] ?? `RCODE ${code}`;
}

function tsigFailure(verdict: Exclude<TsigVerdict, { ok: true }>, access: Rfc2136Access, rcode: number): Message {
  const params = { server: serverLabel(access), key: access.keyName };
  if (verdict.reason === 'error') {
    switch (verdict.error) {
      case TSIG_ERROR.BADKEY:
        return msg(
          'Der Nameserver {server} kennt keinen TSIG-Schlüssel mit dem Namen {key} und diesem Verfahren.',
          params
        );
      case TSIG_ERROR.BADSIG:
        return msg(
          'Der Nameserver {server} hat die Unterschrift abgelehnt. Das Geheimnis des Schlüssels {key} stimmt nicht.',
          params
        );
      case TSIG_ERROR.BADTIME:
        return msg(
          'Die Uhrzeit dieses Servers weicht von der des Nameservers {server} um mehr als fünf Minuten ab. TSIG lehnt die Anfrage deshalb ab.',
          params
        );
      default:
        return msg('Der Nameserver {server} hat die Unterschrift abgelehnt (TSIG-Fehler {code}).', {
          ...params,
          code: verdict.error ?? 0,
        });
    }
  }
  if (verdict.reason === 'time') {
    return msg(
      'Die Uhrzeit dieses Servers weicht von der des Nameservers {server} um mehr als fünf Minuten ab. TSIG lehnt die Antwort deshalb ab.',
      params
    );
  }
  if (verdict.reason === 'unsigned') {
    return msg(
      'Der Nameserver {server} hat ohne Unterschrift geantwortet ({rcode}). Er kennt den Schlüssel {key} nicht oder unterstützt TSIG nicht.',
      { ...params, rcode: rcodeName(rcode) }
    );
  }
  return msg('Die Antwort des Nameservers {server} ist nicht gültig unterschrieben. Sie wurde verworfen.', params);
}

/** Der Inhalt eines Eintrags zum Wiederfinden: Name, Art und Inhalt, wie er auf der Leitung steht. */
interface RecordKey {
  name: string;
  type: number;
  rdata: Buffer;
}

export function encodeRecordId(key: RecordKey): string {
  return Buffer.from(JSON.stringify([key.name, key.type, key.rdata.toString('base64')])).toString('base64url');
}

export function decodeRecordId(id: string): RecordKey | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(id, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [name, type, rdata] = parsed as unknown[];
    if (typeof name !== 'string' || typeof type !== 'number' || typeof rdata !== 'string') return null;
    return { name, type, rdata: Buffer.from(rdata, 'base64') };
  } catch {
    return null;
  }
}

function toRecord(wire: WireRecord, zoneName: string): DnsRecord {
  const name = canonicalName(wire.name);
  return {
    id: encodeRecordId({ name, type: wire.type, rdata: wire.rdata }),
    type: typeName(wire.type),
    name,
    content: wire.content ?? '',
    ttl: wire.ttl,
    proxied: false,
    priority: wire.priority,
    comment: null,
    // Die NS-Einträge der Zone selbst: ohne sie wird sie nicht mehr ausgeliefert.
    locked: wire.type === TYPE.SOA || (wire.type === TYPE.NS && name === canonicalName(zoneName)),
  };
}

function within(name: string, zone: string): boolean {
  return name === zone || name.endsWith(`.${zone}`);
}

export interface Rfc2136Provider extends DnsProvider {
  /**
   * Ob der Nameserver den Schlüssel kennt, ohne dass eine Zone feststeht: eine
   * unterschriebene Frage, auf die jede unterschriebene Antwort genügt. Für den
   * Einrichtungsassistenten, der die Domain erst im nächsten Schritt erfährt.
   */
  probe(access: Rfc2136Access): Promise<void>;
}

/** `exchange` und `clock` sind im Betrieb TCP und die Uhr, im Test nachgestellt. */
export function createRfc2136(
  exchange: DnsExchange = tcpExchange,
  clock: () => number = () => Date.now()
): Rfc2136Provider {
  function accessOf(token: string): { access: Rfc2136Access; key: TsigKey } {
    const access = readRfc2136Access(token);
    if (!access) {
      throw new ApiError(msg('Die gespeicherten Zugangsdaten des Nameservers sind unvollständig. Bitte neu hinterlegen.'), 409);
    }
    return { access, key: keyOf(access) };
  }

  function keyOf(access: Rfc2136Access): TsigKey {
    return { name: access.keyName, algorithm: access.algorithm, secret: Buffer.from(access.secret, 'base64') };
  }

  async function send(access: Rfc2136Access, key: TsigKey, input: Omit<MessageInput, 'id'>): Promise<DecodedMessage> {
    const id = randomInt(0, 0x10000);
    const now = Math.floor(clock() / 1000);
    const { wire, mac } = signMessage(encodeMessage({ ...input, id }), key, now);

    let response: Buffer;
    try {
      response = await exchange(access.server, access.port, wire);
    } catch (err) {
      throw new DnsUnreachableError(
        err instanceof Error && err.name === 'TimeoutError'
          ? msg('Der Nameserver {server} hat nicht rechtzeitig geantwortet.', { server: serverLabel(access) })
          : msg('Der Nameserver {server} ist über TCP nicht erreichbar.', { server: serverLabel(access) }),
        502
      );
    }

    let decoded: DecodedMessage;
    let verdict: TsigVerdict;
    try {
      decoded = decodeMessage(response);
      verdict = verifyTsig(response, key, mac, now);
    } catch {
      throw new ApiError(
        msg('Der Nameserver {server} hat eine Antwort geschickt, die HAPM nicht lesen kann.', {
          server: serverLabel(access),
        }),
        502
      );
    }
    if (!verdict.ok) throw new ApiError(tsigFailure(verdict, access, decoded.rcode), 502);
    if (decoded.id !== id) {
      throw new ApiError(
        msg('Die Antwort des Nameservers {server} gehört nicht zu dieser Anfrage. Sie wurde verworfen.', {
          server: serverLabel(access),
        }),
        502
      );
    }
    return decoded;
  }

  function ask(access: Rfc2136Access, key: TsigKey, name: string, type: number): Promise<DecodedMessage> {
    return send(access, key, { opcode: OPCODE.QUERY, question: { name, type, class: CLASS.IN } });
  }

  function update(
    access: Rfc2136Access,
    key: TsigKey,
    zone: string,
    prerequisites: WriteRecord[],
    changes: WriteRecord[]
  ): Promise<DecodedMessage> {
    return send(access, key, {
      opcode: OPCODE.UPDATE,
      question: { name: zone, type: TYPE.SOA, class: CLASS.IN },
      answer: prerequisites,
      authority: changes,
    });
  }

  /** Was eine abgelehnte Änderung heißt. Die Vorbedingungen deutet der Aufrufer vorher selbst. */
  function updateFailure(access: Rfc2136Access, zone: string, rcode: number): ApiError {
    const params = { server: serverLabel(access), zone, key: access.keyName };
    switch (rcode) {
      case RCODE.REFUSED:
        return new ApiError(
          msg(
            'Der Nameserver {server} lässt den Schlüssel {key} die Zone {zone} nicht ändern. Dort fehlt die Freigabe (allow-update oder update-policy).',
            params
          ),
          502
        );
      case RCODE.NOTAUTH:
        return new ApiError(
          msg(
            'Der Nameserver {server} führt {zone} nicht als primäre Zone. Änderungen nimmt nur der primäre Nameserver an.',
            params
          ),
          502
        );
      case RCODE.NOTZONE:
        return new ApiError(msg('Der Name liegt nicht in der Zone {zone}.', params), 400);
      case RCODE.NOTIMP:
        return new ApiError(msg('Der Nameserver {server} nimmt keine Änderungen über RFC 2136 an.', params), 502);
      default:
        return new ApiError(
          msg('Der Nameserver {server} hat die Änderung an {zone} abgelehnt ({rcode}).', {
            ...params,
            rcode: rcodeName(rcode),
          }),
          502
        );
    }
  }

  function queryFailure(access: Rfc2136Access, name: string, rcode: number): ApiError {
    return new ApiError(
      msg('Der Nameserver {server} beantwortet die Frage nach {name} nicht ({rcode}).', {
        server: serverLabel(access),
        name,
        rcode: rcodeName(rcode),
      }),
      502
    );
  }

  /**
   * Die Zone, in der die Domain liegt, oder `null`: der längste Name ab der
   * Domain aufwärts, dessen SOA dieser Nameserver als eigenen beantwortet.
   */
  async function findZone(access: Rfc2136Access, key: TsigKey, domain: string): Promise<string | null> {
    const labels = canonicalName(domain).replace(/^\*\./, '').split('.').filter(Boolean);
    for (let i = 0; i + 2 <= labels.length; i += 1) {
      const candidate = labels.slice(i).join('.');
      const answer = await ask(access, key, candidate, TYPE.SOA);
      if (answer.rcode !== RCODE.NOERROR && answer.rcode !== RCODE.NXDOMAIN) continue;
      if (!answer.authoritative) {
        // Eine Verweisung: die Domain führt ein anderer Nameserver.
        if (answer.authority.some((record) => record.type === TYPE.NS)) return null;
        continue;
      }
      const own = answer.answer.find(
        (record) => record.type === TYPE.SOA && canonicalName(record.name) === candidate
      );
      if (own) return candidate;
      // Eine verneinende Antwort nennt den SOA der Zone, in der der Name läge.
      const enclosing = answer.authority.find(
        (record) => record.type === TYPE.SOA && within(candidate, canonicalName(record.name))
      );
      if (enclosing) return canonicalName(enclosing.name);
    }
    return null;
  }

  function prerequisite(name: string, type: number, cls: number): WriteRecord {
    return { name, type, class: cls, ttl: 0, rdata: Buffer.alloc(0) };
  }

  /** Ob es den Namen in der Zone wirklich gibt (und nicht nur ein Stern für ihn antwortet). */
  async function nameExists(access: Rfc2136Access, key: TsigKey, zone: string, name: string): Promise<boolean> {
    const answer = await update(access, key, zone, [prerequisite(name, TYPE.ANY, CLASS.ANY)], []);
    // Darf der Schlüssel nicht fragen, bleibt es bei dem, was die Abfrage gezeigt hat.
    return answer.rcode !== RCODE.NXDOMAIN;
  }

  function ownAnswers(answer: DecodedMessage, name: string, type: number): WireRecord[] {
    return answer.answer.filter((record) => record.type === type && canonicalName(record.name) === name);
  }

  /** Ob die Einträge unter `name` aus einem Stern in der Zone stammen. */
  async function synthesized(
    access: Rfc2136Access,
    key: TsigKey,
    zone: string,
    name: string,
    found: WireRecord[]
  ): Promise<boolean> {
    if (name === zone || name.startsWith('*.')) return false;
    const parent = name.slice(name.indexOf('.') + 1);
    if (!within(parent, zone)) return false;
    const sample = found[0];
    const neighbour = `hapm-${randomBytes(6).toString('hex')}.${parent}`;
    const probe = await ask(access, key, neighbour, sample.type);
    if (probe.rcode !== RCODE.NOERROR) return false;
    const theirs = ownAnswers(probe, neighbour, sample.type).map((record) => record.rdata.toString('hex'));
    const ours = found.filter((record) => record.type === sample.type).map((record) => record.rdata.toString('hex'));
    if (theirs.length === 0 || theirs.length !== ours.length || !ours.every((value) => theirs.includes(value))) {
      return false;
    }
    return !(await nameExists(access, key, zone, name));
  }

  async function recordsAt(access: Rfc2136Access, key: TsigKey, zone: string, name: string): Promise<WireRecord[]> {
    const first = await ask(access, key, name, READ_TYPES[0]);
    if (first.rcode === RCODE.NXDOMAIN) return [];
    if (first.rcode !== RCODE.NOERROR) throw queryFailure(access, name, first.rcode);
    if (!first.authoritative) {
      throw new ApiError(
        msg('Der Nameserver {server} führt {name} nicht selbst. Angebunden werden kann nur der Nameserver, der die Zone führt.', {
          server: serverLabel(access),
          name,
        }),
        502
      );
    }
    const rest = await Promise.all(READ_TYPES.slice(1).map((type) => ask(access, key, name, type)));
    const found = [first, ...rest].flatMap((answer, index) =>
      answer.rcode === RCODE.NOERROR ? ownAnswers(answer, name, READ_TYPES[index]) : []
    );
    if (found.length > 0 && (await synthesized(access, key, zone, name, found))) return [];
    return found;
  }

  function writeTarget(zone: ZoneRef, input: RecordWrite): { name: string; type: number; rdata: Buffer; zoneName: string } {
    const zoneName = canonicalName(zone.name);
    const name = canonicalName(input.name);
    const type = typeCode(input.type);
    if (type === null || !WRITE_TYPES.has(type)) {
      throw new ApiError(msg('Einen {type}-Eintrag schreibt HAPM über RFC 2136 nicht.', { type: input.type }));
    }
    if (!within(name, zoneName)) {
      throw new ApiError(msg('{name} liegt nicht in der Zone {zone}.', { name, zone: zoneName }));
    }
    try {
      return { name, type, rdata: encodeRdata(type, input.content, input.priority), zoneName };
    } catch {
      throw new ApiError(msg('Der Wert "{content}" passt nicht zu einem {type}-Eintrag.', { content: input.content, type: input.type }));
    }
  }

  /** Nach einer Änderung: steht der Eintrag jetzt so in der Zone? */
  async function confirm(
    access: Rfc2136Access,
    key: TsigKey,
    target: { name: string; type: number; rdata: Buffer; zoneName: string }
  ): Promise<DnsRecord> {
    const answer = await ask(access, key, target.name, target.type);
    const stored = ownAnswers(answer, target.name, target.type).find((record) => record.rdata.equals(target.rdata));
    if (!stored) {
      throw new ApiError(
        msg(
          'Der Nameserver {server} hat die Änderung angenommen, der Eintrag {name} steht danach aber nicht in der Zone. Gespeichert ist nichts.',
          { server: serverLabel(access), name: target.name }
        ),
        502
      );
    }
    return toRecord(stored, target.zoneName);
  }

  function currentKey(current: DnsRecord): RecordKey {
    const known = decodeRecordId(current.id);
    if (known) return known;
    const type = typeCode(current.type);
    if (type === null) throw new ApiError(msg('Diesen Eintrag kann HAPM nicht benennen.'), 400);
    return { name: canonicalName(current.name), type, rdata: encodeRdata(type, current.content, current.priority) };
  }

  const gone = () => new ApiError(msg('Diesen Eintrag gibt es beim Nameserver nicht (mehr).'), 404);

  return {
    id: 'rfc2136',

    async probe(access) {
      await ask(access, keyOf(access), '.', TYPE.SOA);
    },

    async listZones(token, near): Promise<ProviderZone[]> {
      const { access, key } = accessOf(token);
      if (!near) {
        throw new ApiError(msg('Ein Nameserver nennt über RFC 2136 seine Zonen nicht. Bitte die Domain angeben.'));
      }
      const zone = await findZone(access, key, near);
      // Die Kennung ist der Nameserver: eine eigene hat eine Zone hier nicht.
      return zone ? [{ id: serverLabel(access), name: zone, delegated: null }] : [];
    },

    async assertWritable(token, zone) {
      const { access, key } = accessOf(token);
      const zoneName = canonicalName(zone.name);
      // Eine Änderung ohne Inhalt: der Nameserver prüft Zone, Schlüssel und
      // (bei allow-update) die Freigabe, und ändert nichts.
      const answer = await update(access, key, zoneName, [], []);
      if (answer.rcode !== RCODE.NOERROR) throw updateFailure(access, zoneName, answer.rcode);
    },

    async listRecords(token, zone, names): Promise<DnsRecord[]> {
      const { access, key } = accessOf(token);
      const zoneName = canonicalName(zone.name);
      if (!names || names.length === 0) {
        throw new ApiError(msg('Ein Nameserver nennt über RFC 2136 nicht alle Einträge einer Zone. Gelesen wird je Name.'));
      }
      const wanted = [...new Set(names.map(canonicalName))].filter((name) => within(name, zoneName));
      const found: DnsRecord[] = [];
      for (const name of wanted) {
        const records = await recordsAt(access, key, zoneName, name);
        found.push(...records.map((record) => toRecord(record, zoneName)));
      }
      return found;
    },

    async createRecord(token, zone, input): Promise<DnsRecord> {
      const { access, key } = accessOf(token);
      const target = writeTarget(zone, input);

      let ttl = input.ttl;
      if (target.type !== TYPE.CNAME) {
        // Die TTL gehört dem Namen samt Art: ein neuer Wert übernimmt die der vorhandenen.
        const existing = ownAnswers(await ask(access, key, target.name, target.type), target.name, target.type);
        if (existing.some((record) => record.rdata.equals(target.rdata))) {
          throw new ApiError(msg('Ein Eintrag mit diesem Namen, dieser Art und diesem Wert steht dort bereits.'), 409);
        }
        if (ttl === null && existing.length > 0) ttl = existing[0].ttl;
      }

      const answer = await update(
        access,
        key,
        target.zoneName,
        target.type === TYPE.CNAME
          ? // Ein CNAME verträgt nichts neben sich: der Name muss frei sein.
            [prerequisite(target.name, TYPE.ANY, CLASS.NONE)]
          : // Und neben einem CNAME steht nichts anderes.
            [prerequisite(target.name, TYPE.CNAME, CLASS.NONE)],
        [{ name: target.name, type: target.type, class: CLASS.IN, ttl: ttl ?? RFC2136_DEFAULT_TTL, rdata: target.rdata }]
      );
      if (answer.rcode === RCODE.YXDOMAIN) {
        throw new ApiError(
          msg('Unter {name} steht beim Nameserver bereits ein Eintrag. Er wurde nicht angefasst.', { name: target.name }),
          409
        );
      }
      if (answer.rcode === RCODE.YXRRSET) {
        throw new ApiError(
          msg('Unter {name} steht beim Nameserver ein CNAME-Eintrag. Daneben ist kein weiterer Eintrag möglich.', {
            name: target.name,
          }),
          409
        );
      }
      if (answer.rcode !== RCODE.NOERROR) throw updateFailure(access, target.zoneName, answer.rcode);
      return confirm(access, key, target);
    },

    async updateRecord(token, zone, current, input): Promise<DnsRecord> {
      const { access, key } = accessOf(token);
      const target = writeTarget(zone, input);
      const old = currentKey(current);
      const ttl = input.ttl ?? current.ttl ?? RFC2136_DEFAULT_TTL;

      // Eine Nachricht: der Nameserver führt sie ganz aus oder gar nicht.
      const answer = await update(
        access,
        key,
        target.zoneName,
        [prerequisite(old.name, old.type, CLASS.ANY)],
        [
          { name: old.name, type: old.type, class: CLASS.NONE, ttl: 0, rdata: old.rdata },
          { name: target.name, type: target.type, class: CLASS.IN, ttl, rdata: target.rdata },
        ]
      );
      if (answer.rcode === RCODE.NXRRSET || answer.rcode === RCODE.NXDOMAIN) throw gone();
      if (answer.rcode !== RCODE.NOERROR) throw updateFailure(access, target.zoneName, answer.rcode);
      return confirm(access, key, target);
    },

    async deleteRecord(token, zone, current): Promise<void> {
      const { access, key } = accessOf(token);
      const zoneName = canonicalName(zone.name);
      const old = currentKey(current);
      const answer = await update(
        access,
        key,
        zoneName,
        [prerequisite(old.name, old.type, CLASS.ANY)],
        [{ name: old.name, type: old.type, class: CLASS.NONE, ttl: 0, rdata: old.rdata }]
      );
      if (answer.rcode === RCODE.NXRRSET || answer.rcode === RCODE.NXDOMAIN) throw gone();
      if (answer.rcode !== RCODE.NOERROR) throw updateFailure(access, zoneName, answer.rcode);
    },
  };
}

export const rfc2136: Rfc2136Provider = createRfc2136();
