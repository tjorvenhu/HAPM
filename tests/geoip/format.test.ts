import { describe, it, expect } from 'vitest';
import {
  compileGeoTable,
  decodeGeoTable,
  ipToKey,
  lookupCountry,
  GeoTableError,
  type GeoTable,
} from '@/lib/geoip/format';

/**
 * Die Länder-Tabelle: übersetzen, zurücklesen, nachschlagen.
 *
 * Geprüft wird an einem winzigen Datensatz und nicht an den 700 000 Bereichen
 * der echten Datei — die Grenzfälle sind alle klein: die Lücke, der Bereich am
 * Rand des Adressraums, die Adresse, die keine ist, und die
 * IPv4-in-IPv6-Schreibweise, in der ein Proxy mit `v4v6`-Socket jeden
 * IPv4-Besucher meldet.
 */

const META = { version: '2026-08', source: 'Test', builtAt: '2026-08-01T00:00:00.000Z' };

function build(csv: string): GeoTable {
  return decodeGeoTable(compileGeoTable(csv, META).bytes);
}

describe('ipToKey', () => {
  it('liest IPv4', () => {
    expect(ipToKey('0.0.0.0')).toEqual({ family: 4, key: 0n });
    expect(ipToKey('1.2.3.4')).toEqual({ family: 4, key: 16909060n });
    expect(ipToKey('255.255.255.255')).toEqual({ family: 4, key: 4294967295n });
  });

  it('löst die IPv4-in-IPv6-Schreibweise nach IPv4 auf', () => {
    // Beide Formen derselben Adresse. Als IPv6 gelesen landete jeder
    // IPv4-Besucher im ::ffff:0:0/96-Bereich statt in seinem Land.
    expect(ipToKey('::ffff:1.2.3.4')).toEqual({ family: 4, key: 16909060n });
    expect(ipToKey('::ffff:102:304')).toEqual({ family: 4, key: 16909060n });
  });

  it('kürzt IPv6 auf die oberen 64 Bit', () => {
    const parsed = ipToKey('2a01:4f8:c17:5::1');
    expect(parsed).toEqual({ family: 6, key: 0x2a0104f80c170005n });
    // Alles im selben /64 hat denselben Schlüssel.
    expect(ipToKey('2a01:4f8:c17:5:ffff:ffff:ffff:ffff')).toEqual(parsed);
  });

  it('gibt null zurück, wo keine Adresse steht', () => {
    // HAProxy schreibt `-`, wenn die Verbindung abbrach, bevor eine Quelle
    // feststand. Als 0 gelesen landete sie unter 0.0.0.0 — im Datensatz ein
    // Bereich wie jeder andere.
    for (const value of ['', '-', '1.2.3', '1.2.3.4.5', '256.0.0.1', '1.2.3.04x', 'kein:hex:g']) {
      expect(ipToKey(value)).toBeNull();
    }
  });

  it('weist eine IPv6-Adresse ohne :: zurück, die nicht vollständig ist', () => {
    expect(ipToKey('2a01:4f8')).toBeNull();
    expect(ipToKey('1:2:3:4:5:6:7:8')).not.toBeNull();
    expect(ipToKey('1:2:3:4:5:6:7:8:9')).toBeNull();
  });
});

describe('compileGeoTable / lookupCountry', () => {
  const table = build(
    [
      '0.0.0.0,0.255.255.255,ZZ',
      '1.0.0.0,1.0.0.255,AU',
      '1.0.1.0,1.0.3.255,CN',
      '8.8.8.0,8.8.8.255,US',
      '255.255.255.0,255.255.255.255,DE',
      '2a01:4f8::,2a01:4f8:ffff:ffff:ffff:ffff:ffff:ffff,DE',
      '2400::,2400:ffff:ffff:ffff:ffff:ffff:ffff:ffff,SG',
    ].join('\n')
  );

  it('trägt den Kopf durch', () => {
    expect(table.version).toBe('2026-08');
    expect(table.source).toBe('Test');
  });

  it('findet das Land eines Bereichs', () => {
    expect(lookupCountry(table, '1.0.0.7')).toBe('AU');
    expect(lookupCountry(table, '1.0.2.99')).toBe('CN');
    expect(lookupCountry(table, '8.8.8.8')).toBe('US');
    expect(lookupCountry(table, '255.255.255.255')).toBe('DE');
    expect(lookupCountry(table, '2a01:4f8:c17:5::1')).toBe('DE');
    expect(lookupCountry(table, '2400:1:2:3::9')).toBe('SG');
  });

  it('trifft die Ränder eines Bereichs', () => {
    expect(lookupCountry(table, '1.0.0.0')).toBe('AU');
    expect(lookupCountry(table, '1.0.0.255')).toBe('AU');
    expect(lookupCountry(table, '1.0.1.0')).toBe('CN');
  });

  it('macht aus ZZ einen unbekannten Wert und keine Flagge', () => {
    // „ZZ" ist im Datensatz der Platzhalter. Als Ländercode durchgereicht
    // stünde in der Oberfläche eine Flagge, die es nicht gibt.
    expect(lookupCountry(table, '0.4.5.6')).toBeNull();
  });

  it('füllt eine LÜCKE mit unbekannt und nicht mit dem Land davor', () => {
    // Zwischen 1.0.3.255 und 8.8.8.0 nennt der Datensatz nichts. Ohne die
    // ausdrückliche Endmarke liefe „CN" bis 8.8.8.0 weiter — eine erfundene
    // Auskunft, die wie eine gemessene aussieht.
    expect(lookupCountry(table, '5.5.5.5')).toBeNull();
    expect(lookupCountry(table, '1.0.4.0')).toBeNull();
  });

  it('verliert bei IPv6 nichts, wenn ein einzelner Host mitten aus einem /64 herausgeschnitten ist', () => {
    // DE, darin ein französischer Host, danach geht DE weiter: drei Zeilen in der Quelle.
    const table = build(
      [
        '2001:db8::,2001:db8:0:5::ffff,DE',
        '2001:db8:0:5::1:0,2001:db8:0:5::1:0,FR',
        '2001:db8:0:5::1:1,2001:db8:ffff:ffff:ffff:ffff:ffff:ffff,DE',
        '2001:db9::,2001:db9:ffff:ffff:ffff:ffff:ffff:ffff,NL',
      ].join('\n')
    );
    expect(lookupCountry(table, '2001:db8:0:4::1')).toBe('DE');
    // Das angeschnittene /64 bleibt bei dem Land, das an seinem Anfang gilt.
    expect(lookupCountry(table, '2001:db8:0:5::1:0')).toBe('DE');
    // Dahinter war vorher „unbekannt".
    expect(lookupCountry(table, '2001:db8:0:6::1')).toBe('DE');
    expect(lookupCountry(table, '2001:db8:1::1')).toBe('DE');
    expect(lookupCountry(table, '2001:db9::1')).toBe('NL');
  });

  it('antwortet auch unterhalb des ersten Bereichs', () => {
    const sparse = build('9.0.0.0,9.0.0.255,US');
    expect(lookupCountry(sparse, '1.1.1.1')).toBeNull();
    expect(lookupCountry(sparse, '9.0.0.1')).toBe('US');
  });

  it('gibt ohne Tabelle und ohne Adresse null zurück', () => {
    expect(lookupCountry(null, '8.8.8.8')).toBeNull();
    expect(lookupCountry(table, '-')).toBeNull();
    expect(lookupCountry(table, '')).toBeNull();
  });
});

describe('compileGeoTable: was übersprungen wird', () => {
  it('überspringt unbrauchbare Zeilen, statt die Datei wegzuwerfen', () => {
    // Eine einzelne kaputte Zeile ist kein Grund, 700 000 brauchbare
    // wegzuwerfen.
    const built = compileGeoTable(
      [
        'kaputt',
        '1.0.0.0,1.0.0.255,AU',
        '2.0.0.0,2.0.0.255,ZWEI', // kein Ländercode
        '3.0.0.0', // zu wenige Spalten
        '',
        '4.0.0.0,4.0.0.255,US',
      ].join('\n'),
      META
    );
    const table = decodeGeoTable(built.bytes);
    expect(lookupCountry(table, '1.0.0.1')).toBe('AU');
    expect(lookupCountry(table, '4.0.0.1')).toBe('US');
    expect(lookupCountry(table, '2.0.0.1')).toBeNull();
  });

  it('fasst zwei gleiche Länder nebeneinander zu einem Bereich zusammen', () => {
    const built = compileGeoTable(
      ['1.0.0.0,1.0.0.255,DE', '1.0.1.0,1.0.1.255,DE'].join('\n'),
      META
    );
    // Zwei Zeilen im CSV, ein Eintrag in der Tabelle — plus die Endmarke
    // dahinter und der Anfang des Adressraums davor.
    expect(lookupCountry(decodeGeoTable(built.bytes), '1.0.1.7')).toBe('DE');
    expect(built.v4Count).toBe(3);
  });
});

describe('decodeGeoTable', () => {
  it('weist etwas zurück, das keine übersetzte Tabelle ist', () => {
    expect(() => decodeGeoTable(new TextEncoder().encode('irgendwas'))).toThrow(GeoTableError);
    expect(() => decodeGeoTable(new Uint8Array(0))).toThrow(GeoTableError);
  });
});
