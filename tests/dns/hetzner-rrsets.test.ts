import { describe, it, expect } from 'vitest';
import {
  decodeRecordId,
  encodeRecordId,
  formatTxt,
  parseTxt,
  planCreate,
  planDelete,
  planUpdate,
  readValue,
  rrsetName,
  rrsetToRecords,
  rrsetsToRecords,
  writeConflict as conflictOf,
  writeValue,
  type HetznerRRSet,
  type ValueTarget,
} from '@/lib/dns/hetzner-rrsets';
import { germanText } from '@/lib/i18n';

/** Die Meldung als deutscher Text: die Prüfung liefert sie als `msg()`. */
const writeConflict = (...args: Parameters<typeof conflictOf>) => {
  const message = conflictOf(...args);
  return message && germanText(message);
};

/**
 * Hetzner führt je Name und Art einen Satz von Werten, die Oberfläche zeigt
 * einzelne Einträge. Hier steht, wie das eine aus dem anderen wird, und vor
 * allem: dass eine Änderung an einem Wert die anderen nie mitnimmt.
 */

const ZONE = 'example.org';

function rrset(patch: Partial<HetznerRRSet> = {}): HetznerRRSet {
  return {
    name: 'www',
    type: 'A',
    ttl: 3600,
    records: [{ value: '203.0.113.10' }, { value: '203.0.113.11', comment: 'zweiter' }],
    ...patch,
  };
}

function target(patch: Partial<ValueTarget> = {}): ValueTarget {
  return { name: 'www', type: 'A', value: '203.0.113.12', comment: null, ttl: 3600, ...patch };
}

describe('rrsetToRecords', () => {
  it('macht aus einem Satz mit zwei Werten zwei Einträge mit vollem Namen', () => {
    const records = rrsetToRecords(rrset(), ZONE);
    expect(records).toHaveLength(2);
    expect(records.map((r) => [r.type, r.name, r.content, r.ttl])).toEqual([
      ['A', 'www.example.org', '203.0.113.10', 3600],
      ['A', 'www.example.org', '203.0.113.11', 3600],
    ]);
    expect(records[0].comment).toBeNull();
    expect(records[1].comment).toBe('zweiter');
    // Jeder Wert hat seine eigene Kennung, sonst träfe Löschen beide.
    expect(records[0].id).not.toBe(records[1].id);
  });

  it('schreibt die Zone selbst als ihren Namen und nicht als `@`', () => {
    const [record] = rrsetToRecords(rrset({ name: '@', records: [{ value: '203.0.113.10' }] }), ZONE);
    expect(record.name).toBe('example.org');
  });

  it('lässt eine fehlende TTL unbekannt, statt eine zu erfinden', () => {
    const [record] = rrsetToRecords(rrset({ ttl: null }), ZONE);
    expect(record.ttl).toBeNull();
  });

  it('kennt keinen Proxy', () => {
    expect(rrsetToRecords(rrset(), ZONE).every((r) => r.proxied === false)).toBe(true);
  });

  it('sperrt, was Hetzner selbst pflegt oder jemand dort geschützt hat', () => {
    const soa = rrsetToRecords(
      rrset({ name: '@', type: 'SOA', records: [{ value: 'hydrogen.ns.hetzner.com. dns.hetzner.com. 1 2 3 4 5' }] }),
      ZONE
    )[0];
    const apexNs = rrsetToRecords(
      rrset({ name: '@', type: 'NS', records: [{ value: 'hydrogen.ns.hetzner.com.' }] }),
      ZONE
    )[0];
    const delegation = rrsetToRecords(
      rrset({ name: 'intern', type: 'NS', records: [{ value: 'ns1.example.net.' }] }),
      ZONE
    )[0];
    const guarded = rrsetToRecords(rrset({ protection: { change: true } }), ZONE)[0];

    expect(soa.locked).toBe(true);
    expect(apexNs.locked).toBe(true);
    expect(guarded.locked).toBe(true);
    // Eine Delegation unterhalb der Zone gehört dem Betreiber.
    expect(delegation.locked).toBe(false);
  });

  it('ordnet die Einträge einer Zone nach Art und Name', () => {
    const records = rrsetsToRecords(
      [
        rrset({ name: 'www', type: 'CNAME', records: [{ value: 'example.org.' }] }),
        rrset({ name: 'b', records: [{ value: '203.0.113.2' }] }),
        rrset({ name: 'a', records: [{ value: '203.0.113.1' }] }),
      ],
      ZONE
    );
    expect(records.map((r) => `${r.type} ${r.name}`)).toEqual([
      'A a.example.org',
      'A b.example.org',
      'CNAME www.example.org',
    ]);
  });
});

describe('Kennung', () => {
  it('besteht aus Name, Art und Wert und lässt sich zurücklesen', () => {
    const key = { name: '_dmarc', type: 'TXT', value: '"v=DMARC1; p=none"' };
    expect(decodeRecordId(encodeRecordId(key))).toEqual(key);
  });

  it('passt in einen Pfad der eigenen API', () => {
    const id = encodeRecordId({ name: '@', type: 'MX', value: '10 mail.example.org.' });
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('erkennt eine fremde Kennung als fremd', () => {
    // So sieht die Kennung eines Cloudflare-Eintrags aus.
    expect(decodeRecordId('372e67954025e0ba6aaa6d586b9e0b59')).toBeNull();
    expect(decodeRecordId('')).toBeNull();
  });

  it('ist für denselben Wert in zwei Sätzen verschieden', () => {
    expect(encodeRecordId({ name: 'a', type: 'A', value: '203.0.113.1' })).not.toBe(
      encodeRecordId({ name: 'b', type: 'A', value: '203.0.113.1' })
    );
  });
});

describe('Werte lesen und schreiben', () => {
  it('führt Ziele mit Punkt und zeigt sie ohne', () => {
    expect(writeValue('CNAME', 'example.org', null)).toBe('example.org.');
    expect(writeValue('CNAME', 'example.org.', null)).toBe('example.org.');
    expect(writeValue('NS', 'ns1.example.net', null)).toBe('ns1.example.net.');
    expect(readValue('CNAME', 'example.org.', ZONE)).toEqual({ content: 'example.org', priority: null });
  });

  it('liest ein Ziel ohne Punkt relativ zur Zone, wie eine Zonendatei', () => {
    expect(readValue('CNAME', 'www', ZONE).content).toBe('www.example.org');
    expect(readValue('CNAME', '@', ZONE).content).toBe('example.org');
  });

  it('trennt beim MX die Priorität vom Ziel', () => {
    expect(writeValue('MX', 'mail.example.org', 10)).toBe('10 mail.example.org.');
    expect(readValue('MX', '10 mail.example.org.', ZONE)).toEqual({
      content: 'mail.example.org',
      priority: 10,
    });
  });

  it('erfindet keine Priorität, wo keine zu lesen ist', () => {
    expect(readValue('MX', 'mail.example.org.', ZONE)).toEqual({
      content: 'mail.example.org.',
      priority: null,
    });
  });

  it('lässt Adressen und unbekannte Arten, wie sie sind', () => {
    expect(writeValue('A', ' 203.0.113.10 ', null)).toBe('203.0.113.10');
    expect(readValue('SRV', '10 5 5060 sip.example.org.', ZONE).content).toBe(
      '10 5 5060 sip.example.org.'
    );
  });

  it('kommt für jede bearbeitbare Art beim selben Wert wieder an', () => {
    const cases: [string, string, number | null][] = [
      ['A', '203.0.113.10', null],
      ['AAAA', '2001:db8::1', null],
      ['CNAME', 'ziel.example.net', null],
      ['NS', 'ns1.example.net', null],
      ['MX', 'mail.example.org', 20],
      ['TXT', 'v=spf1 include:_spf.example.net ~all', null],
    ];
    for (const [type, content, priority] of cases) {
      expect(readValue(type, writeValue(type, content, priority), ZONE)).toEqual({ content, priority });
    }
  });
});

describe('TXT', () => {
  it('setzt den Text in Anführungszeichen', () => {
    expect(formatTxt('v=spf1 -all')).toBe('"v=spf1 -all"');
    expect(writeValue('TXT', 'v=spf1 -all', null)).toBe('"v=spf1 -all"');
  });

  it('lässt stehen, was schon in Anführungszeichen kommt', () => {
    expect(formatTxt('"v=spf1 -all"')).toBe('"v=spf1 -all"');
  });

  it('maskiert Anführungszeichen und Rückstrich im Text', () => {
    expect(formatTxt('a "b" c\\d')).toBe('"a \\"b\\" c\\\\d"');
    expect(parseTxt(formatTxt('a "b" c\\d'))).toBe('a "b" c\\d');
  });

  it('teilt einen langen Text in Stücke von 255 Zeichen und fügt sie wieder zusammen', () => {
    const key = `v=DKIM1; k=rsa; p=${'A'.repeat(600)}`;
    const value = formatTxt(key);
    const chunks = value.split('" "');
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(256);
    expect(parseTxt(value)).toBe(key);
  });

  it('liest einen Wert ohne Anführungszeichen, wie er dasteht', () => {
    expect(parseTxt('v=spf1 -all')).toBe('v=spf1 -all');
  });
});

describe('rrsetName', () => {
  it('rechnet den vollen Namen in den des Satzes um', () => {
    expect(rrsetName('www.example.org', ZONE)).toBe('www');
    expect(rrsetName('example.org', ZONE)).toBe('@');
    expect(rrsetName('*.example.org', ZONE)).toBe('*');
    expect(rrsetName('a.b.example.org', ZONE)).toBe('a.b');
  });
});

describe('planCreate', () => {
  it('fügt einem bestehenden Satz genau einen Wert hinzu und nennt dessen TTL', () => {
    expect(planCreate(target(), rrset())).toEqual([
      {
        action: 'add_records',
        name: 'www',
        type: 'A',
        body: { ttl: 3600, records: [{ value: '203.0.113.12' }] },
      },
    ]);
  });

  it('legt einen neuen Satz mit der gewählten TTL an', () => {
    expect(planCreate(target({ ttl: 300, comment: 'HAPM' }), null)).toEqual([
      {
        action: 'add_records',
        name: 'www',
        type: 'A',
        body: { ttl: 300, records: [{ value: '203.0.113.12', comment: 'HAPM' }] },
      },
    ]);
  });

  it('schickt keine TTL, wenn die Vorgabe der Zone gelten soll', () => {
    expect(planCreate(target({ ttl: null }), null)[0].body).toEqual({
      records: [{ value: '203.0.113.12' }],
    });
  });

  it('wechselt die TTL eines Satzes erst nach dem Hinzufügen, und nur auf Wunsch', () => {
    const steps = planCreate(target({ ttl: 300 }), rrset());
    expect(steps.map((s) => s.action)).toEqual(['add_records', 'change_ttl']);
    // Hetzner verlangt beim Hinzufügen die TTL, die der Satz schon hat.
    expect(steps[0].body.ttl).toBe(3600);
    expect(steps[1].body).toEqual({ ttl: 300 });
    // „Keine eigene TTL" beim Anlegen setzt die der Nachbarn nicht zurück.
    expect(planCreate(target({ ttl: null }), rrset()).map((s) => s.action)).toEqual(['add_records']);
  });
});

describe('planDelete', () => {
  it('entfernt nur den einen Wert', () => {
    expect(planDelete({ name: 'www', type: 'A', value: '203.0.113.10' })).toEqual([
      {
        action: 'remove_records',
        name: 'www',
        type: 'A',
        body: { records: [{ value: '203.0.113.10' }] },
      },
    ]);
  });
});

describe('planUpdate', () => {
  const current = { name: 'www', type: 'A', value: '203.0.113.10' };

  it('tauscht einen Wert, ohne den Satz neu zu schreiben', () => {
    const steps = planUpdate(current, target(), rrset());
    // Erst der neue, dann der alte: der Name ist nie leer, und der zweite Wert
    // des Satzes kommt in keinem Aufruf vor.
    expect(steps.map((s) => s.action)).toEqual(['add_records', 'remove_records']);
    expect(steps[0].body).toEqual({ ttl: 3600, records: [{ value: '203.0.113.12' }] });
    expect(steps[1].body).toEqual({ records: [{ value: '203.0.113.10' }] });
    expect(JSON.stringify(steps)).not.toContain('203.0.113.11');
    expect(steps.some((s) => s.action === 'set_records')).toBe(false);
  });

  it('ersetzt den Wert eines CNAME in einem Schritt, weil ein Name nur einen trägt', () => {
    const cname = rrset({ type: 'CNAME', records: [{ value: 'alt.example.net.' }] });
    const steps = planUpdate(
      { name: 'www', type: 'CNAME', value: 'alt.example.net.' },
      target({ type: 'CNAME', value: 'neu.example.net.' }),
      cname
    );
    expect(steps).toEqual([
      {
        action: 'set_records',
        name: 'www',
        type: 'CNAME',
        body: { records: [{ value: 'neu.example.net.' }] },
      },
    ]);
  });

  it('ändert nur die Notiz, wenn nur die Notiz anders ist', () => {
    const steps = planUpdate(
      { name: 'www', type: 'A', value: '203.0.113.11' },
      target({ value: '203.0.113.11', comment: 'neu' }),
      rrset()
    );
    expect(steps).toEqual([
      {
        action: 'update_records',
        name: 'www',
        type: 'A',
        body: { records: [{ value: '203.0.113.11', comment: 'neu' }] },
      },
    ]);
  });

  it('wechselt die TTL des Satzes, auch zurück auf die Vorgabe der Zone', () => {
    expect(planUpdate(current, target({ value: current.value, ttl: 300 }), rrset())).toEqual([
      { action: 'change_ttl', name: 'www', type: 'A', body: { ttl: 300 } },
    ]);
    expect(planUpdate(current, target({ value: current.value, ttl: null }), rrset())).toEqual([
      { action: 'change_ttl', name: 'www', type: 'A', body: { ttl: null } },
    ]);
  });

  it('tut nichts, wenn schon alles so dasteht', () => {
    expect(planUpdate(current, target({ value: current.value }), rrset())).toEqual([]);
  });

  it('zieht einen Wert unter einen anderen Namen um: dort hinzufügen, hier entfernen', () => {
    const steps = planUpdate(current, target({ name: 'app', value: current.value }), null);
    expect(steps.map((s) => [s.action, s.name])).toEqual([
      ['add_records', 'app'],
      ['remove_records', 'www'],
    ]);
  });
});

describe('writeConflict', () => {
  it('lässt einen neuen Wert neben den vorhandenen zu', () => {
    expect(writeConflict(target(), rrset(), null)).toBeNull();
    expect(writeConflict(target(), null, null)).toBeNull();
  });

  it('weist einen Wert ab, der schon dasteht', () => {
    expect(writeConflict(target({ value: '203.0.113.11' }), rrset(), null)).toMatch(/steht dort bereits/);
    // Auch beim Ändern: der Wert würde auf seinen Nachbarn fallen.
    expect(
      writeConflict(target({ value: '203.0.113.11' }), rrset(), {
        name: 'www',
        type: 'A',
        value: '203.0.113.10',
      })
    ).toMatch(/steht dort bereits/);
  });

  it('hält den eigenen Wert nicht für einen fremden', () => {
    const own = { name: 'www', type: 'A', value: '203.0.113.10' };
    expect(writeConflict(target({ value: own.value, ttl: 300 }), rrset(), own)).toBeNull();
  });

  it('legt keinen zweiten CNAME unter denselben Namen', () => {
    const cname = rrset({ type: 'CNAME', records: [{ value: 'alt.example.net.' }] });
    expect(
      writeConflict(target({ type: 'CNAME', value: 'neu.example.net.' }), cname, null)
    ).toMatch(/nur einen/);
  });
});
