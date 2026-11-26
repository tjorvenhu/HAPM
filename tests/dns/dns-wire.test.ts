import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CLASS,
  OPCODE,
  TSIG_ERROR,
  TYPE,
  decodeMessage,
  decodeName,
  encodeMessage,
  encodeName,
  encodeRdata,
  signMessage,
  verifyTsig,
  type TsigKey,
} from '@/lib/dns/dns-wire';
import { FakeNameserver, rr } from './fake-nameserver';

/**
 * Was auf die Leitung geht: Namen, Inhalte, der Kopf einer Nachricht und die
 * Unterschrift (TSIG). Die Erwartungen stehen als Bytes da, wie RFC 1035 und
 * RFC 8945 sie beschreiben, nicht als Ausgabe derselben Funktionen.
 */

const KEY: TsigKey = {
  name: 'hapm-key',
  algorithm: 'hmac-sha256',
  secret: Buffer.from('c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LTEyMzQ=', 'base64'),
};

const hex = (value: Buffer) => value.toString('hex');

describe('Namen', () => {
  it('schreibt Labels mit ihrer Länge und einer Null am Ende', () => {
    expect(hex(encodeName('app.example.org'))).toBe('03617070076578616d706c65036f726700');
    expect(hex(encodeName('example.org.'))).toBe('076578616d706c65036f726700');
    expect(hex(encodeName('.'))).toBe('00');
    expect(hex(encodeName('*.example.org'))).toBe('012a076578616d706c65036f726700');
  });

  it('lehnt ein leeres oder zu langes Label ab', () => {
    expect(() => encodeName('a..b')).toThrow();
    expect(() => encodeName(`${'x'.repeat(64)}.org`)).toThrow();
  });

  it('liest einen gekürzten Namen über seinen Zeiger', () => {
    // An Stelle 0 steht `example.org`, an Stelle 13 `app` und ein Zeiger auf 0.
    const message = Buffer.concat([encodeName('example.org'), Buffer.from('03617070c000', 'hex')]);
    expect(decodeName(message, 13)).toEqual({ name: 'app.example.org', next: 19 });
  });

  it('läuft bei einem Zeiger auf sich selbst nicht endlos', () => {
    expect(() => decodeName(Buffer.from('c000', 'hex'), 0)).toThrow();
  });
});

describe('Inhalte', () => {
  it('schreibt Adressen als Bytes', () => {
    expect(hex(encodeRdata(TYPE.A, '192.0.2.10'))).toBe('c000020a');
    expect(hex(encodeRdata(TYPE.AAAA, '2001:db8::1'))).toBe('20010db8000000000000000000000001');
    expect(hex(encodeRdata(TYPE.AAAA, '::ffff:192.0.2.1'))).toBe('00000000000000000000ffffc0000201');
  });

  it('lehnt ab, was keine Adresse ist', () => {
    expect(() => encodeRdata(TYPE.A, '192.0.2')).toThrow();
    expect(() => encodeRdata(TYPE.A, '192.0.2.256')).toThrow();
    expect(() => encodeRdata(TYPE.AAAA, '2001:db8:::1')).toThrow();
  });

  it('teilt einen TXT-Text in Stücke zu höchstens 255 Bytes', () => {
    const rdata = encodeRdata(TYPE.TXT, 'x'.repeat(300));
    expect(rdata.length).toBe(302);
    expect(rdata[0]).toBe(255);
    expect(rdata[256]).toBe(45);
    expect(hex(encodeRdata(TYPE.TXT, ''))).toBe('00');
  });

  it('schreibt das Ziel eines CNAME ungekürzt', () => {
    expect(hex(encodeRdata(TYPE.CNAME, 'example.org'))).toBe('076578616d706c65036f726700');
  });

  it('schreibt nur die Arten, die HAPM kennt', () => {
    expect(() => encodeRdata(TYPE.SOA, 'x')).toThrow();
  });
});

describe('Nachrichten', () => {
  it('baut eine Abfrage ohne Rekursion', () => {
    const wire = encodeMessage({ id: 0x1234, opcode: OPCODE.QUERY, question: { name: 'example.org', type: TYPE.A, class: CLASS.IN } });
    expect(hex(wire)).toBe('123400000001000000000000' + '076578616d706c65036f726700' + '00010001');
  });

  it('baut eine Änderung: Zone, Vorbedingung, Eintrag', () => {
    const wire = encodeMessage({
      id: 1,
      opcode: OPCODE.UPDATE,
      question: { name: 'example.org', type: TYPE.SOA, class: CLASS.IN },
      answer: [{ name: 'app.example.org', type: TYPE.ANY, class: CLASS.NONE, ttl: 0, rdata: Buffer.alloc(0) }],
      authority: [{ name: 'app.example.org', type: TYPE.CNAME, class: CLASS.IN, ttl: 3600, rdata: encodeRdata(TYPE.CNAME, 'example.org') }],
    });
    // Opcode 5 steht in den Bits 11 bis 14 des zweiten Wortes.
    expect(wire.readUInt16BE(2)).toBe(0x2800);
    expect([4, 6, 8, 10].map((at) => wire.readUInt16BE(at))).toEqual([1, 1, 1, 0]);

    const read = decodeMessage(wire);
    expect(read.opcode).toBe(OPCODE.UPDATE);
    expect(read.question).toEqual({ name: 'example.org', type: TYPE.SOA, class: CLASS.IN });
    expect(read.answer[0]).toMatchObject({ name: 'app.example.org', type: TYPE.ANY, class: CLASS.NONE, ttl: 0 });
    expect(read.authority[0]).toMatchObject({ type: TYPE.CNAME, ttl: 3600, content: 'example.org' });
  });

  it('liest Inhalte als Text und merkt sich die ungekürzte Form', () => {
    const server = new FakeNameserver().addKey(KEY);
    server.addZone('example.org', ['hapm-key'], [
      rr('a.example.org', 'A', '192.0.2.10'),
      rr('v6.example.org', 'AAAA', '2001:db8:0:0:0:0:0:1'),
      rr('t.example.org', 'TXT', 'hallo welt'),
    ]);
    const ask = (name: string, type: number) =>
      server.exchange('', 53, signMessage(encodeMessage({ id: 7, opcode: OPCODE.QUERY, question: { name, type, class: CLASS.IN } }), KEY, server.now).wire);

    return Promise.all([ask('a.example.org', TYPE.A), ask('v6.example.org', TYPE.AAAA), ask('t.example.org', TYPE.TXT)]).then(
      ([a, v6, txt]) => {
        expect(decodeMessage(a).answer[0].content).toBe('192.0.2.10');
        // Die kurze Schreibweise nach RFC 5952.
        expect(decodeMessage(v6).answer[0].content).toBe('2001:db8::1');
        expect(decodeMessage(txt).answer[0].content).toBe('hallo welt');
        expect(decodeMessage(a).authoritative).toBe(true);
      }
    );
  });

  it('scheitert an einer abgeschnittenen Nachricht, statt Unsinn zu lesen', () => {
    const wire = encodeMessage({ id: 1, opcode: OPCODE.QUERY, question: { name: 'example.org', type: TYPE.A, class: CLASS.IN } });
    expect(() => decodeMessage(wire.subarray(0, 8))).toThrow();
    expect(() => decodeMessage(wire.subarray(0, 20))).toThrow();
  });
});

describe('TSIG', () => {
  const message = encodeMessage({ id: 0xbeef, opcode: OPCODE.QUERY, question: { name: 'example.org', type: TYPE.SOA, class: CLASS.IN } });
  const time = 1_800_000_000;

  it('unterschreibt die Nachricht und die Angaben aus RFC 8945, 4.3.3', () => {
    const { wire, mac } = signMessage(message, KEY, time);

    // Name des Schlüssels, Klasse ANY, TTL 0, Verfahren, Zeit (48 Bit), Spielraum 300, Fehler 0, keine weiteren Daten.
    const variables = Buffer.concat([
      Buffer.from('086861706d2d6b657900', 'hex'),
      Buffer.from('00ff00000000', 'hex'),
      Buffer.from('0b686d61632d73686132353600', 'hex'),
      Buffer.from('00006b49d200', 'hex'),
      Buffer.from('012c00000000', 'hex'),
    ]);
    const expected = createHmac('sha256', KEY.secret).update(message).update(variables).digest();
    expect(hex(mac)).toBe(hex(expected));

    // Der Eintrag hängt hinten an und zählt im Kopf mit, die Nachricht davor bleibt.
    expect(wire.readUInt16BE(10)).toBe(1);
    expect(hex(wire.subarray(12, message.length))).toBe(hex(message.subarray(12)));
    const tsig = decodeMessage(wire).additional[0];
    expect(tsig).toMatchObject({ name: 'hapm-key', type: TYPE.TSIG, class: CLASS.ANY, ttl: 0 });
  });

  it('führt den Namen des Schlüssels klein, wie der Empfänger ihn vergleicht', () => {
    const upper = signMessage(message, { ...KEY, name: 'HAPM-Key.' }, time);
    expect(hex(upper.mac)).toBe(hex(signMessage(message, KEY, time).mac));
  });

  function answered(server: FakeNameserver, key: TsigKey = KEY) {
    const signed = signMessage(message, key, server.now);
    return server.exchange('', 53, signed.wire).then((response) => ({ response, mac: signed.mac }));
  }

  it('nimmt eine Antwort an, die mit demselben Schlüssel unterschrieben ist', async () => {
    const server = new FakeNameserver().addKey(KEY);
    server.addZone('example.org', []);
    const { response, mac } = await answered(server);
    expect(verifyTsig(response, KEY, mac, server.now)).toEqual({ ok: true });
  });

  it('verwirft eine Antwort, die jemand anderes unterschrieben hat', async () => {
    const server = new FakeNameserver().addKey(KEY);
    server.addZone('example.org', []);
    server.forge = true;
    const { response, mac } = await answered(server);
    expect(verifyTsig(response, KEY, mac, server.now)).toMatchObject({ ok: false, reason: 'mismatch' });
  });

  it('verwirft eine Antwort, an der nach dem Unterschreiben etwas geändert wurde', async () => {
    const server = new FakeNameserver().addKey(KEY);
    server.addZone('example.org', []);
    const { response, mac } = await answered(server);
    const tampered = Buffer.from(response);
    // Der Antwortcode im Kopf: aus „abgelehnt" würde „in Ordnung".
    tampered[3] ^= 0x05;
    expect(verifyTsig(tampered, KEY, mac, server.now)).toMatchObject({ ok: false, reason: 'mismatch' });
  });

  it('verwirft eine Antwort zu einer anderen Anfrage', async () => {
    const server = new FakeNameserver().addKey(KEY);
    server.addZone('example.org', []);
    const { response } = await answered(server);
    expect(verifyTsig(response, KEY, Buffer.alloc(32, 1), server.now)).toMatchObject({ ok: false, reason: 'mismatch' });
  });

  it('verwirft eine Antwort ohne Unterschrift', async () => {
    const server = new FakeNameserver().addKey(KEY);
    server.addZone('example.org', []);
    server.unsigned = true;
    const { response, mac } = await answered(server);
    expect(verifyTsig(response, KEY, mac, server.now)).toMatchObject({ ok: false, reason: 'unsigned' });
  });

  it('gibt den Fehler weiter, den der Nameserver nennt', async () => {
    const server = new FakeNameserver().addKey(KEY);
    const unknown = await answered(server, { ...KEY, name: 'fremd' });
    expect(verifyTsig(unknown.response, { ...KEY, name: 'fremd' }, unknown.mac, server.now)).toEqual({
      ok: false,
      reason: 'error',
      error: TSIG_ERROR.BADKEY,
    });
    const wrong = { ...KEY, secret: Buffer.from('falsch-falsch-falsch') };
    const rejected = await answered(server, wrong);
    expect(verifyTsig(rejected.response, wrong, rejected.mac, server.now)).toMatchObject({ error: TSIG_ERROR.BADSIG });
  });

  it('verwirft eine gültige Antwort, deren Zeit zu weit abweicht', async () => {
    const server = new FakeNameserver().addKey(KEY);
    server.addZone('example.org', []);
    const { response, mac } = await answered(server);
    expect(verifyTsig(response, KEY, mac, server.now + 301)).toMatchObject({ ok: false, reason: 'time' });
    expect(verifyTsig(response, KEY, mac, server.now + 299)).toEqual({ ok: true });
  });
});
