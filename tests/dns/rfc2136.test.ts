import { beforeEach, describe, expect, it } from 'vitest';
import { packAccess, type Rfc2136Access } from '@/lib/dns/access';
import { CLASS, OPCODE, TYPE, type TsigKey } from '@/lib/dns/dns-wire';
import { DnsUnreachableError } from '@/lib/dns/errors';
import { RFC2136_DEFAULT_TTL, createRfc2136, decodeRecordId, type Rfc2136Provider } from '@/lib/dns/rfc2136';
import type { DnsRecord } from '@/lib/dns/records';
import { FakeNameserver, rr } from './fake-nameserver';

/**
 * Der eigene Nameserver über RFC 2136, ohne Netz: hinter dem Anbieter steht
 * ein nachgestellter Nameserver (`fake-nameserver.ts`), der jede Nachricht
 * liest, die Unterschrift prüft und selbst unterschrieben antwortet.
 *
 * Geprüft wird, was an der Auslegung hängt: wie die Zone gefunden wird, welche
 * Vorbedingungen eine Änderung trägt, und was HAPM aus den Antworten macht.
 * Dasselbe gegen ein echtes BIND: `pnpm dns:verify`.
 */

const SECRET = 'c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LTEyMzQ=';
const KEY: TsigKey = { name: 'hapm-key', algorithm: 'hmac-sha256', secret: Buffer.from(SECRET, 'base64') };
const OTHER: TsigKey = { name: 'other-key', algorithm: 'hmac-sha512', secret: Buffer.from('ein-anderes-geheimnis-123') };

const ZONE = { id: 'ns1.example.org', name: 'example.org' };

let server: FakeNameserver;
let provider: Rfc2136Provider;

const access = (over: Partial<Rfc2136Access> = {}): string =>
  packAccess({ server: 'ns1.example.org', port: 53, keyName: 'hapm-key', algorithm: 'hmac-sha256', secret: SECRET, ...over });

const describeRecords = (records: DnsRecord[]) =>
  records.map((record) => `${record.type} ${record.content}`).sort().join(' | ');

async function failure(work: () => Promise<unknown>): Promise<{ message: string; status: number }> {
  try {
    await work();
  } catch (err) {
    return { message: (err as Error).message, status: (err as { status?: number }).status ?? 0 };
  }
  throw new Error('Der Aufruf hätte scheitern müssen.');
}

beforeEach(() => {
  server = new FakeNameserver().addKey(KEY).addKey(OTHER);
  server.addZone('example.org', ['hapm-key'], [
    rr('example.org', 'A', '192.0.2.10'),
    rr('old.example.org', 'A', '192.0.2.20', 120),
    rr('old.example.org', 'A', '192.0.2.21', 120),
    rr('alias.example.org', 'CNAME', 'example.org'),
    rr('note.example.org', 'TXT', 'hallo welt'),
    rr('*.wild.example.org', 'CNAME', 'example.org'),
    rr('real.wild.example.org', 'CNAME', 'example.org'),
  ]);
  server.addZone('intern.example.org', ['hapm-key']);
  provider = createRfc2136(server.exchange, () => server.now * 1000);
});

describe('listZones', () => {
  it('findet die Zone, in der die Domain liegt', async () => {
    expect(await provider.listZones(access(), 'app.sub.example.org')).toEqual([
      { id: 'ns1.example.org', name: 'example.org', delegated: null },
    ]);
  });

  it('nimmt die engere Zone, wenn der Nameserver beide führt', async () => {
    expect((await provider.listZones(access(), 'app.intern.example.org'))[0].name).toBe('intern.example.org');
  });

  it('findet sie auch für die Zone selbst und für eine Wildcard', async () => {
    expect((await provider.listZones(access(), 'example.org'))[0].name).toBe('example.org');
    expect((await provider.listZones(access(), '*.example.org'))[0].name).toBe('example.org');
  });

  it('liefert nichts für eine Domain, die der Nameserver nicht führt', async () => {
    expect(await provider.listZones(access(), 'app.fremd.example')).toEqual([]);
  });

  it('nennt den Port in der Kennung nur, wenn er abweicht', async () => {
    expect((await provider.listZones(access({ port: 5353 }), 'example.org'))[0].id).toBe('ns1.example.org:5353');
  });

  it('zählt ohne Domain nichts auf, sondern sagt, was fehlt', async () => {
    expect((await failure(() => provider.listZones(access()))).message).toContain('Bitte die Domain angeben');
  });

  it('sagt bei einem falschen Geheimnis, dass es das Geheimnis ist', async () => {
    const wrong = Buffer.from('falsch-falsch-falsch-falsch').toString('base64');
    expect((await failure(() => provider.listZones(access({ secret: wrong }), 'example.org'))).message).toContain(
      'Das Geheimnis des Schlüssels hapm-key stimmt nicht'
    );
  });

  it('sagt bei einem unbekannten Schlüssel, dass der Nameserver ihn nicht kennt', async () => {
    expect((await failure(() => provider.listZones(access({ keyName: 'fremd' }), 'example.org'))).message).toContain(
      'kennt keinen TSIG-Schlüssel mit dem Namen fremd'
    );
  });

  it('sagt bei abweichender Uhr, dass es die Uhr ist', async () => {
    const late = createRfc2136(server.exchange, () => (server.now + 1000) * 1000);
    expect((await failure(() => late.listZones(access(), 'example.org'))).message).toContain('Die Uhrzeit dieses Servers');
  });

  it('verwirft eine Antwort ohne Unterschrift', async () => {
    server.unsigned = true;
    expect((await failure(() => provider.listZones(access(), 'example.org'))).message).toContain('ohne Unterschrift geantwortet');
  });

  it('verwirft eine untergeschobene Antwort', async () => {
    server.forge = true;
    expect((await failure(() => provider.listZones(access(), 'example.org'))).message).toContain(
      'nicht gültig unterschrieben'
    );
  });

  it('meldet einen Nameserver, der nicht antwortet, als nicht erreichbar', async () => {
    const down = createRfc2136(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(down.listZones(access(), 'example.org')).rejects.toBeInstanceOf(DnsUnreachableError);
    const slow = createRfc2136(async () => {
      const error = new Error('Zeitüberschreitung');
      error.name = 'TimeoutError';
      throw error;
    });
    expect((await failure(() => slow.listZones(access(), 'example.org'))).message).toContain('nicht rechtzeitig');
  });

  it('lehnt einen gespeicherten Zugang ab, der keiner ist', async () => {
    expect((await failure(() => provider.listZones('kein-json', 'example.org'))).status).toBe(409);
    expect((await failure(() => provider.listZones('{"server":"ns1"}', 'example.org'))).status).toBe(409);
  });
});

describe('assertWritable', () => {
  it('schickt eine Änderung ohne Inhalt und ändert nichts', async () => {
    const before = server.zones[0].records.length;
    await provider.assertWritable!(access(), ZONE);
    const sent = server.seen[server.seen.length - 1];
    expect(sent.opcode).toBe(OPCODE.UPDATE);
    expect(sent.answer).toHaveLength(0);
    expect(sent.authority).toHaveLength(0);
    expect(server.zones[0].records).toHaveLength(before);
  });

  it('sagt, wenn der Schlüssel die Zone nicht ändern darf', async () => {
    const other = access({ keyName: 'other-key', algorithm: 'hmac-sha512', secret: OTHER.secret.toString('base64') });
    expect((await failure(() => provider.assertWritable!(other, ZONE))).message).toContain(
      'lässt den Schlüssel other-key die Zone example.org nicht ändern'
    );
  });

  it('sagt, wenn der Nameserver die Zone nicht als primäre führt', async () => {
    expect((await failure(() => provider.assertWritable!(access(), { id: '', name: 'fremd.example' }))).message).toContain(
      'nicht als primäre Zone'
    );
  });
});

describe('listRecords', () => {
  const read = (...names: string[]) => provider.listRecords(access(), ZONE, names);

  it('liest gezielt unter den genannten Namen', async () => {
    expect(describeRecords(await read('old.example.org'))).toBe('A 192.0.2.20 | A 192.0.2.21');
    expect(describeRecords(await read('alias.example.org'))).toBe('CNAME example.org');
    expect(describeRecords(await read('note.example.org'))).toBe('TXT hallo welt');
    expect(describeRecords(await read('alias.example.org', 'note.example.org'))).toBe('CNAME example.org | TXT hallo welt');
  });

  it('fragt bei einem freien Namen nur einmal', async () => {
    server.seen.length = 0;
    expect(await read('frei.example.org')).toEqual([]);
    // NXDOMAIN auf die erste Frage: die übrigen Arten erübrigen sich.
    expect(server.seen).toHaveLength(1);
    expect(server.seen[0].question).toMatchObject({ name: 'frei.example.org', type: TYPE.CNAME });
  });

  it('trägt die TTL des Nameservers und sperrt die NS-Einträge der Zone', async () => {
    const records = await read('old.example.org', 'example.org');
    expect(records.find((record) => record.content === '192.0.2.20')?.ttl).toBe(120);
    expect(records.find((record) => record.type === 'NS')).toMatchObject({ locked: true, name: 'example.org' });
    expect(records.find((record) => record.type === 'A' && record.name === 'example.org')?.locked).toBe(false);
  });

  it('hält die Antwort eines Sterns nicht für einen Eintrag des Namens', async () => {
    expect(await read('irgendwas.wild.example.org')).toEqual([]);
  });

  it('liest einen echten Eintrag neben dem Stern, auch wenn er dasselbe sagt', async () => {
    expect(describeRecords(await read('real.wild.example.org'))).toBe('CNAME example.org');
    // Entschieden hat die Vorbedingung „der Name ist belegt", ohne etwas zu ändern.
    const probe = server.seen.find((message) => message.opcode === OPCODE.UPDATE)!;
    expect(probe.answer[0]).toMatchObject({ name: 'real.wild.example.org', type: TYPE.ANY, class: CLASS.ANY });
    expect(probe.authority).toHaveLength(0);
  });

  it('liest den Stern selbst als Eintrag', async () => {
    expect(describeRecords(await read('*.wild.example.org'))).toBe('CNAME example.org');
  });

  it('übergeht Namen außerhalb der Zone und zählt ohne Namen nichts auf', async () => {
    expect(await read('app.fremd.example')).toEqual([]);
    expect((await failure(() => provider.listRecords(access(), ZONE))).message).toContain('Gelesen wird je Name');
  });
});

describe('createRecord', () => {
  const cname = { type: 'CNAME', name: 'app.example.org', content: 'example.org', ttl: null, comment: 'HAPM' };

  it('legt einen CNAME nur an, wenn unter dem Namen nichts steht', async () => {
    const created = await provider.createRecord(access(), ZONE, cname);
    expect(created).toMatchObject({ type: 'CNAME', name: 'app.example.org', content: 'example.org', ttl: RFC2136_DEFAULT_TTL });

    const sent = server.seen.find((message) => message.opcode === OPCODE.UPDATE)!;
    expect(sent.question).toMatchObject({ name: 'example.org', type: TYPE.SOA });
    // RFC 2136, 2.4.5: Klasse NONE, Art ANY heißt „der Name ist nicht belegt".
    expect(sent.answer).toHaveLength(1);
    expect(sent.answer[0]).toMatchObject({ name: 'app.example.org', type: TYPE.ANY, class: CLASS.NONE, ttl: 0 });
    expect(sent.authority[0]).toMatchObject({ name: 'app.example.org', type: TYPE.CNAME, class: CLASS.IN, ttl: 3600 });
  });

  it('lehnt einen CNAME neben vorhandenen Daten ab und lässt sie stehen', async () => {
    const taken = await failure(() => provider.createRecord(access(), ZONE, { ...cname, name: 'old.example.org' }));
    expect(taken.status).toBe(409);
    expect(taken.message).toContain('bereits ein Eintrag');
    expect(describeRecords(await provider.listRecords(access(), ZONE, ['old.example.org']))).toBe('A 192.0.2.20 | A 192.0.2.21');
  });

  it('lehnt einen Eintrag neben einem CNAME ab', async () => {
    const beside = await failure(() =>
      provider.createRecord(access(), ZONE, { type: 'A', name: 'alias.example.org', content: '192.0.2.99', ttl: null })
    );
    expect(beside.status).toBe(409);
    expect(beside.message).toContain('CNAME-Eintrag');
  });

  it('übernimmt für einen zweiten Wert die TTL, die der Name schon hat', async () => {
    const second = await provider.createRecord(access(), ZONE, { type: 'A', name: 'old.example.org', content: '192.0.2.22', ttl: null });
    expect(second.ttl).toBe(120);
  });

  it('legt denselben Wert kein zweites Mal an', async () => {
    const twice = await failure(() =>
      provider.createRecord(access(), ZONE, { type: 'A', name: 'old.example.org', content: '192.0.2.20', ttl: null })
    );
    expect(twice.status).toBe(409);
  });

  it('meldet einen Eintrag nicht als gespeichert, den der Nameserver still übergangen hat', async () => {
    // Ein Nameserver, der die Vorbedingung nicht auswertet: der CNAME neben den
    // A-Einträgen wird angenommen und weggeworfen (RFC 2136, 3.4.2.2).
    server.ignorePrerequisites = true;
    const lost = await failure(() => provider.createRecord(access(), ZONE, { ...cname, name: 'old.example.org' }));
    expect(lost.status).toBe(502);
    expect(lost.message).toContain('steht danach aber nicht in der Zone');
  });

  it('schreibt nur die Arten, die HAPM setzt, und nur in der Zone', async () => {
    expect((await failure(() => provider.createRecord(access(), ZONE, { ...cname, type: 'MX' }))).message).toContain('MX-Eintrag');
    expect((await failure(() => provider.createRecord(access(), ZONE, { ...cname, name: 'app.fremd.example' }))).message).toContain(
      'liegt nicht in der Zone'
    );
    expect(
      (await failure(() => provider.createRecord(access(), ZONE, { type: 'A', name: 'x.example.org', content: 'keine-adresse', ttl: null }))).message
    ).toContain('passt nicht zu einem A-Eintrag');
  });

  it('sagt, wenn der Schlüssel den Eintrag nicht schreiben darf', async () => {
    const other = access({ keyName: 'other-key', algorithm: 'hmac-sha512', secret: OTHER.secret.toString('base64') });
    expect((await failure(() => provider.createRecord(other, ZONE, cname))).message).toContain('nicht ändern');
  });
});

describe('updateRecord und deleteRecord', () => {
  async function host(): Promise<DnsRecord> {
    return provider.createRecord(access(), ZONE, { type: 'A', name: 'host.example.org', content: '192.0.2.50', ttl: 600 });
  }

  it('ändert einen Wert in einer Nachricht: alter weg, neuer hin', async () => {
    const before = await host();
    server.seen.length = 0;
    const after = await provider.updateRecord(access(), ZONE, before, { type: 'A', name: 'host.example.org', content: '192.0.2.51', ttl: before.ttl });
    expect(after).toMatchObject({ content: '192.0.2.51', ttl: 600 });

    const updates = server.seen.filter((message) => message.opcode === OPCODE.UPDATE);
    expect(updates).toHaveLength(1);
    expect(updates[0].authority.map((change) => change.class)).toEqual([CLASS.NONE, CLASS.IN]);
    expect(updates[0].authority[0].content).toBe('192.0.2.50');
    expect(describeRecords(await provider.listRecords(access(), ZONE, ['host.example.org']))).toBe('A 192.0.2.51');
  });

  it('entfernt genau den einen Wert', async () => {
    const [first] = (await provider.listRecords(access(), ZONE, ['old.example.org'])).filter((record) => record.content === '192.0.2.20');
    await provider.deleteRecord(access(), ZONE, first);
    expect(describeRecords(await provider.listRecords(access(), ZONE, ['old.example.org']))).toBe('A 192.0.2.21');
  });

  it('sagt „gibt es nicht (mehr)", wenn der Eintrag schon weg ist', async () => {
    const record = await host();
    await provider.deleteRecord(access(), ZONE, record);
    expect((await failure(() => provider.deleteRecord(access(), ZONE, record))).status).toBe(404);
    expect((await failure(() => provider.updateRecord(access(), ZONE, record, { type: 'A', name: record.name, content: '192.0.2.1', ttl: null }))).status).toBe(404);
  });

  it('benennt den Eintrag über seine Kennung, mit dem Inhalt, wie er auf der Leitung stand', async () => {
    const record = await host();
    expect(decodeRecordId(record.id)).toMatchObject({ name: 'host.example.org', type: TYPE.A });
    expect(decodeRecordId(record.id)!.rdata.toString('hex')).toBe('c0000232');
    expect(decodeRecordId('kein-eintrag')).toBeNull();
  });
});

describe('probe', () => {
  it('nimmt jede unterschriebene Antwort als Beweis für den Schlüssel', async () => {
    await expect(provider.probe({ server: 'ns1', port: 53, keyName: 'hapm-key', algorithm: 'hmac-sha256', secret: SECRET })).resolves.toBeUndefined();
  });

  it('scheitert mit einem falschen Schlüssel', async () => {
    await expect(
      provider.probe({ server: 'ns1', port: 53, keyName: 'fremd', algorithm: 'hmac-sha256', secret: SECRET })
    ).rejects.toThrow('kennt keinen TSIG-Schlüssel');
  });
});
