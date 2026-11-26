import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { crowdsecFingerprint, dataFingerprint, type SyncData } from '@/lib/sync/data';
import { sampleSyncData } from '../helpers/sync-data';
import {
  BundleError,
  collect,
  fingerprintOf,
  isExcluded,
  isExcludedPath,
  pack,
  unpack,
  validEntryPath,
  type BundleEntry,
} from '@/lib/sync/bundle';

/**
 * Das Paket des Abgleichs: was hineingeht, was nie hineingeht, und dass der
 * Empfänger jede Angabe prüft, bevor er etwas schreibt. Die bösartigen Pakete
 * weiter unten baut kein HAPM: sie stehen für einen Fehler im Packen oder für
 * jemanden, der den Kopplungsschlüssel hat.
 */

let base: string;
let haproxy: string;
let acme: string;

function write(dir: string, rel: string, content: string): void {
  const full = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

const SENDER = { nodeId: 'a'.repeat(32), name: 'proxy01', hapmVersion: '0.6.1', haproxyVersion: '3.2.4', exposure: 'public', usesCrowdsec: false };

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'hapm-sync-bundle-'));
  haproxy = path.join(base, 'haproxy');
  acme = path.join(base, 'acme');
  write(haproxy, 'haproxy.cfg', 'global\n    log stdout format raw local0\n');
  write(haproxy, 'certs/example.org.pem', 'CERT+KEY');
  write(haproxy, 'errors/404.http', 'HTTP/1.0 404 Not Found\r\n\r\nnichts');
  write(haproxy, 'errors/404.http.hapm-original', 'eigene Seite');
  write(haproxy, 'hapm-crowdsec/allow.lst', '203.0.113.7\n');
  write(haproxy, 'hapm-geo/CN.lst', '1.0.1.0/24\n');
  write(acme, 'account.conf', "SAVED_CF_Token='geheim'\n");
  write(acme, 'example.org_ecc/example.org.conf', "Le_Domain='example.org'\n");
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function packed() {
  return pack({ seq: 1_800_000_000_000, sender: SENDER }, collect({ haproxy, acme }));
}

describe('Ausschlussliste', () => {
  it('überträgt nicht, was jeder Knoten selbst führt', () => {
    write(haproxy, 'haproxy.cfg.backup-20261126-101500', 'alt');
    write(haproxy, 'haproxy.cfg.hapm-new', 'vorläufig');
    write(haproxy, 'hapm-upload.pem.hapm-previous', 'zwischenstand');
    write(haproxy, '.hapm-restore-old/haproxy.cfg', 'liegengeblieben');
    write(haproxy, '.hapm-sync-new/haproxy.cfg', 'liegengeblieben');
    write(haproxy, 'hapm-crowdsec/spoe.cfg', '[crowdsec]');
    write(haproxy, 'errors/500.http.hapm-new', 'vorläufig');
    write(acme, 'acme.sh', '#!/bin/sh');
    write(acme, 'acme.sh.env', 'export LE_WORKING_DIR');
    write(acme, 'dnsapi/dns_cf.sh', '#!/bin/sh');
    write(acme, 'deploy/haproxy.sh', '#!/bin/sh');
    write(acme, 'notify/mail.sh', '#!/bin/sh');
    write(acme, 'http.header', 'HTTP/2 200');

    const paths = collect({ haproxy, acme }).entries.map((entry) => `${entry.root}/${entry.path}`).sort();
    expect(paths).toEqual([
      'acme/account.conf',
      'acme/example.org_ecc',
      'acme/example.org_ecc/example.org.conf',
      'haproxy/certs',
      'haproxy/certs/example.org.pem',
      'haproxy/errors',
      'haproxy/errors/404.http',
      'haproxy/errors/404.http.hapm-original',
      'haproxy/hapm-crowdsec',
      'haproxy/hapm-crowdsec/allow.lst',
      'haproxy/hapm-geo',
      'haproxy/hapm-geo/CN.lst',
      'haproxy/haproxy.cfg',
    ]);
  });

  it('nimmt einen Ordner mit, den es heute noch nicht gibt', () => {
    // Die Regel heißt „alles außer“: ein neuer Ordner (etwa für eigene CAs) geht von selbst mit.
    write(haproxy, 'hapm-ca/intern.pem', 'CA');
    const paths = collect({ haproxy }).entries.map((entry) => entry.path);
    expect(paths).toContain('hapm-ca/intern.pem');
  });

  it('gilt für alles unter einem ausgeschlossenen Ordner', () => {
    expect(isExcluded('acme', 'dnsapi')).toBe(true);
    expect(isExcluded('acme', 'dnsapi/dns_cf.sh')).toBe(false);
    expect(isExcludedPath('acme', 'dnsapi/dns_cf.sh')).toBe(true);
    expect(isExcludedPath('haproxy', '.hapm-sync-old/haproxy.cfg')).toBe(true);
    expect(isExcludedPath('haproxy', 'certs/example.org.pem')).toBe(false);
    // Nur in der obersten Ebene: der Stand vor einer geänderten Fehlerseite gehört zum Stand.
    expect(isExcludedPath('haproxy', 'errors/404.http.hapm-previous')).toBe(false);
    expect(isExcludedPath('haproxy', 'hapm-upload.pem.hapm-previous')).toBe(true);
  });

  it('übergeht Verweise und nennt sie', () => {
    try {
      fs.symlinkSync(path.join(haproxy, 'haproxy.cfg'), path.join(haproxy, 'verweis.cfg'));
    } catch {
      // Unter Windows ohne Entwicklermodus gibt es keine Verweise.
      return;
    }
    const collected = collect({ haproxy });
    expect(collected.entries.map((entry) => entry.path)).not.toContain('verweis.cfg');
    expect(collected.skipped).toEqual(['haproxy/verweis.cfg']);
  });

  it('lässt einen Ordner weg, den es nicht gibt, und nennt nur die anderen', () => {
    const collected = collect({ haproxy, acme: path.join(base, 'fehlt') });
    expect(collected.roots).toEqual(['haproxy']);
  });
});

describe('Fingerabdruck', () => {
  it('ändert sich mit einem Inhalt, einer neuen und einer entfernten Datei', () => {
    const before = fingerprintOf(collect({ haproxy, acme }).entries);
    expect(fingerprintOf(collect({ haproxy, acme }).entries)).toBe(before);

    write(haproxy, 'certs/example.org.pem', 'CERT+KEY erneuert');
    const changed = fingerprintOf(collect({ haproxy, acme }).entries);
    expect(changed).not.toBe(before);

    write(haproxy, 'certs/neu.example.pem', 'NEU');
    const added = fingerprintOf(collect({ haproxy, acme }).entries);
    expect(added).not.toBe(changed);

    fs.rmSync(path.join(haproxy, 'certs', 'neu.example.pem'));
    expect(fingerprintOf(collect({ haproxy, acme }).entries)).toBe(changed);
  });

  it('ändert sich nicht durch das, was nicht übertragen wird, und nicht durch Zeitstempel', () => {
    const before = fingerprintOf(collect({ haproxy, acme }).entries);
    write(haproxy, 'haproxy.cfg.backup-20261126-101500', 'alt');
    write(haproxy, 'hapm-crowdsec/spoe.cfg', '[crowdsec]');
    write(acme, 'acme.sh', '#!/bin/sh');
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(acme, 'account.conf'), later, later);
    expect(fingerprintOf(collect({ haproxy, acme }).entries)).toBe(before);
  });

  it('unterscheidet dieselbe Datei in zwei Ordnern', () => {
    const entry = { path: 'a', type: 'file' as const, sha256: 'x' };
    expect(fingerprintOf([{ ...entry, root: 'haproxy' }])).not.toBe(fingerprintOf([{ ...entry, root: 'acme' }]));
  });
});

describe('Packen und Auspacken', () => {
  it('bringt jeden Inhalt unverändert hinüber', () => {
    const { bundle, meta } = packed();
    const unpacked = unpack(bundle);
    expect(unpacked.meta.fingerprint).toBe(meta.fingerprint);
    expect(unpacked.meta.sender).toEqual(SENDER);
    expect(unpacked.meta.roots).toEqual(['haproxy', 'acme']);
    expect(unpacked.contents.get('haproxy:certs/example.org.pem')!.toString()).toBe('CERT+KEY');
    expect(unpacked.contents.get('acme:account.conf')!.toString()).toBe("SAVED_CF_Token='geheim'\n");
    expect(unpacked.entries.filter((entry) => entry.type === 'dir').map((entry) => entry.path)).toContain('errors');
  });

  it('überträgt auch eine leere Datei', () => {
    write(haproxy, 'hapm-crowdsec/allow.lst', '');
    const unpacked = unpack(packed().bundle);
    expect(unpacked.contents.get('haproxy:hapm-crowdsec/allow.lst')!.length).toBe(0);
  });
});

describe('der Datenteil', () => {
  const withData = (data: SyncData | null) => pack({ seq: 1_800_000_000_000, sender: SENDER }, collect({ haproxy, acme }), data);

  it('geht mit und trägt zwei eigene Fingerabdrücke', () => {
    const data = sampleSyncData();
    const { bundle, meta } = withData(data);
    expect(meta.dataFingerprint).toBe(dataFingerprint(data));
    expect(meta.crowdsecFingerprint).toBe(crowdsecFingerprint(data.crowdsec!));
    const unpacked = unpack(bundle);
    expect(unpacked.data).toEqual(data);
    expect(unpacked.meta).toMatchObject({ dataFingerprint: meta.dataFingerprint, crowdsecFingerprint: meta.crowdsecFingerprint });
    // Die Dateien haben ihren eigenen: ein neues Passwort ist kein Grund, HAProxy neu zu laden.
    expect(meta.fingerprint).toBe(packed().meta.fingerprint);
  });

  it('fehlt, wenn nur Dateien gepackt werden, und CrowdSec, wenn es nicht zu lesen war', () => {
    expect(unpack(packed().bundle)).toMatchObject({ data: null, meta: { dataFingerprint: null, crowdsecFingerprint: null } });
    const data = { ...sampleSyncData(), crowdsec: null };
    const unpacked = unpack(withData(data).bundle);
    expect(unpacked.meta.dataFingerprint).toBe(dataFingerprint(data));
    expect(unpacked.meta.crowdsecFingerprint).toBeNull();
  });

  it('wird geprüft wie die Dateien: falsche Form und falscher Fingerabdruck lehnen das ganze Paket ab', () => {
    const data = sampleSyncData();
    const prints = { dataFingerprint: dataFingerprint(data), crowdsecFingerprint: crowdsecFingerprint(data.crowdsec!) };
    expect(unpack(forge([CFG.entry], [CFG.content], { ...prints, data })).data).toEqual(data);
    expect(() => unpack(forge([CFG.entry], [CFG.content], { ...prints, dataFingerprint: '0'.repeat(64), data }))).toThrow(/Fingerabdruck des Datenteils/);
    expect(() => unpack(forge([CFG.entry], [CFG.content], { ...prints, crowdsecFingerprint: null, data }))).toThrow(/Fingerabdruck des Datenteils/);
    // Ein Kopf, der Fingerabdrücke nennt, aber keine Daten trägt.
    expect(() => unpack(forge([CFG.entry], [CFG.content], prints))).toThrow(/Fingerabdruck des Datenteils/);
    const empty = { ...data, accounts: { ...data.accounts, users: [] } };
    expect(() => unpack(forge([CFG.entry], [CFG.content], { ...prints, data: empty }))).toThrow(/kein Konto/);
    expect(() => unpack(forge([CFG.entry], [CFG.content], { data: 'kaputt' }))).toThrow(BundleError);
  });
});

/** Ein Paket von Hand, an HAPMs eigenem Packen vorbei. */
function forge(entries: Partial<BundleEntry>[], contents: Buffer[], metaPatch: Record<string, unknown> = {}): Buffer {
  const full = entries as BundleEntry[];
  const meta = {
    protocol: 2,
    seq: 1_800_000_000_000,
    fingerprint: fingerprintOf(full.filter((entry) => typeof entry.path === 'string' && entry.root && entry.type)),
    dataFingerprint: null,
    crowdsecFingerprint: null,
    sender: SENDER,
    roots: ['haproxy', 'acme'],
    skipped: [],
    ...metaPatch,
  };
  const { data, ...metaOnly } = meta as typeof meta & { data?: unknown };
  const head = Buffer.from(JSON.stringify({ v: 2, meta: metaOnly, data: data ?? null, entries }), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(head.length);
  return gzipSync(Buffer.concat([length, head, ...contents]));
}

function file(root: string, rel: unknown, content: string): { entry: Partial<BundleEntry>; content: Buffer } {
  const buffer = Buffer.from(content);
  return {
    entry: { root: root as BundleEntry['root'], path: rel as string, type: 'file', mode: 0o600, size: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') },
    content: buffer,
  };
}

const CFG = file('haproxy', 'haproxy.cfg', 'global\n');

describe('ein Paket, dem nicht zu trauen ist', () => {
  it('nimmt ein von Hand gebautes an, wenn alles stimmt', () => {
    expect(unpack(forge([CFG.entry], [CFG.content])).entries).toHaveLength(1);
  });

  it.each([
    ['../ausserhalb.cfg'],
    ['certs/../../etc/passwd'],
    ['/etc/passwd'],
    ['C:/Windows/system.ini'],
    ['certs\\..\\..\\boot.ini'],
    ['certs//doppelt.pem'],
    ['./haproxy.cfg'],
    ['certs/'],
    [''],
    ['mit\0null'],
    [42],
  ])('lehnt den Pfad %j ab', (rel) => {
    const evil = file('haproxy', rel, 'x');
    expect(() => unpack(forge([CFG.entry, evil.entry], [CFG.content, evil.content]))).toThrow(BundleError);
  });

  it('kennt die Regel für Pfade auch einzeln', () => {
    expect(validEntryPath('certs/example.org.pem')).toBe(true);
    expect(validEntryPath('..')).toBe(false);
    expect(validEntryPath('a/../b')).toBe(false);
    expect(validEntryPath('a'.repeat(2000))).toBe(false);
  });

  it.each([
    ['acme', 'acme.sh'],
    ['acme', 'dnsapi/dns_bose.sh'],
    ['acme', 'deploy/haproxy.sh'],
    ['haproxy', '.hapm-sync-old/haproxy.cfg'],
    ['haproxy', 'hapm-crowdsec/spoe.cfg'],
    ['haproxy', 'haproxy.cfg.hapm-new'],
  ])('lehnt %s/%s ab: das überträgt der Abgleich nie', (root, rel) => {
    // `acme.sh` und die Hooks führt HAPM als root aus. Ein Paket darf sie nicht ersetzen.
    const parent = rel.includes('/') ? [{ root: root as BundleEntry['root'], path: rel.split('/')[0], type: 'dir' as const, mode: 0o755, size: 0, sha256: '' }] : [];
    const evil = file(root, rel, '#!/bin/sh\nboese');
    expect(() => unpack(forge([CFG.entry, ...parent, evil.entry], [CFG.content, evil.content]))).toThrow(/überträgt der Abgleich nie/);
  });

  it('lehnt alles ab, was weder Datei noch Ordner ist', () => {
    const link = { root: 'haproxy' as const, path: 'verweis', type: 'symlink' as unknown as 'file', mode: 0o777, size: 0, sha256: '' };
    expect(() => unpack(forge([CFG.entry, link], [CFG.content]))).toThrow(/weder Datei noch Ordner/);
  });

  it('lehnt eine Datei ab, deren Ordner nicht vor ihr steht', () => {
    const orphan = file('haproxy', 'certs/example.org.pem', 'x');
    expect(() => unpack(forge([CFG.entry, orphan.entry], [CFG.content, orphan.content]))).toThrow(/Ordner über/);
  });

  it('lehnt eine Datei unter einer Datei ab', () => {
    const below = file('haproxy', 'haproxy.cfg/unten', 'x');
    expect(() => unpack(forge([CFG.entry, below.entry], [CFG.content, below.content]))).toThrow(BundleError);
  });

  it('lehnt denselben Pfad zweimal ab', () => {
    expect(() => unpack(forge([CFG.entry, CFG.entry], [CFG.content, CFG.content]))).toThrow(/zweimal/);
  });

  it('lehnt eine falsche Prüfsumme ab', () => {
    const tampered = { ...CFG.entry, sha256: 'f'.repeat(64) };
    expect(() => unpack(forge([tampered], [CFG.content]))).toThrow(/Prüfsumme/);
  });

  it('lehnt Inhalt ab, den der Kopf nicht nennt, und einen Kopf, der mehr nennt als da ist', () => {
    expect(() => unpack(forge([CFG.entry], [CFG.content, Buffer.from('angehängt')]))).toThrow(/mehr, als sein Kopf nennt/);
    expect(() => unpack(forge([{ ...CFG.entry, size: 9999 }], [CFG.content]))).toThrow(/Größe/);
  });

  it('lehnt einen Fingerabdruck ab, der nicht zum Inhalt gehört', () => {
    expect(() => unpack(forge([CFG.entry], [CFG.content], { fingerprint: '0'.repeat(64) }))).toThrow(/Fingerabdruck/);
  });

  it('lehnt ein Paket ohne haproxy.cfg ab', () => {
    const other = file('haproxy', 'anderes.cfg', 'x');
    expect(() => unpack(forge([other.entry], [other.content]))).toThrow(/haproxy\.cfg/);
  });

  it('lehnt einen Eintrag in einem Ordner ab, den das Paket nicht nennt', () => {
    const account = file('acme', 'account.conf', 'x');
    expect(() => unpack(forge([CFG.entry, account.entry], [CFG.content, account.content], { roots: ['haproxy'] }))).toThrow(BundleError);
    expect(() => unpack(forge([CFG.entry], [CFG.content], { roots: ['haproxy', 'root'] }))).toThrow(BundleError);
  });

  it('lehnt eine andere Fassung, eine fehlende Nummer und einen fehlenden Absender ab', () => {
    expect(() => unpack(forge([CFG.entry], [CFG.content], { protocol: 1 }))).toThrow(/Fassung/);
    expect(() => unpack(forge([CFG.entry], [CFG.content], { protocol: 3 }))).toThrow(/Fassung/);
    expect(() => unpack(forge([CFG.entry], [CFG.content], { seq: 0 }))).toThrow(/laufende Nummer/);
    expect(() => unpack(forge([CFG.entry], [CFG.content], { sender: { name: 'x' } }))).toThrow(/Absender/);
  });

  it('lehnt ab, was kein Paket ist', () => {
    expect(() => unpack(Buffer.from('kein gzip'))).toThrow(BundleError);
    expect(() => unpack(gzipSync(Buffer.from([0, 0])))).toThrow(BundleError);
    expect(() => unpack(gzipSync(Buffer.concat([Buffer.from([0, 0, 0, 5]), Buffer.from('{kap')])))).toThrow(BundleError);
  });
});
