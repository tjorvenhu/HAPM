import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import {
  FALLBACK_PEM_NAME,
  certListingCommand,
  inspectUpload,
  isPemFileName,
  parseCertListing,
  servedFiles,
  uploadedCertificates,
  uploadedCoverage,
  type InspectedUpload,
} from '@/lib/haproxy/cert-upload';
import { certificateUse, findCertificateFor, type AcmeCertificate } from '@/lib/haproxy/certs';
import { germanText, type Message } from '@/lib/i18n/translate';
import {
  CA_CERT,
  CN_ONLY_CERT,
  CN_ONLY_KEY,
  LEAF_CERT,
  LEAF_KEY,
  LEAF_KEY_ENCRYPTED,
  LEAF_NOT_AFTER,
  LEAF_NOT_BEFORE,
  OTHER_KEY,
} from './fixtures/upload-certs';

/**
 * Was beim Hochladen geprüft wird, bevor etwas auf die Platte geht, und wie
 * ein hochgeladenes Zertifikat dort wiedererkannt wird.
 *
 * Der teure Fehler wäre ein Schlüssel, der nicht passt: HAProxy lehnt die
 * Datei dann beim Neuladen ab, und `haproxy -c` scheitert an der ganzen
 * Konfiguration statt an diesem Zertifikat.
 */

const NOW = Date.parse('2027-01-01T00:00:00Z');

function ok(certificate: string, privateKey: string, now = NOW): InspectedUpload {
  const result = inspectUpload({ certificate, privateKey }, now);
  if (!result.ok) throw new Error(germanText(result.message));
  return result.value;
}

function refused(certificate: string, privateKey: string, now = NOW): string {
  const result = inspectUpload({ certificate, privateKey }, now);
  if (result.ok) throw new Error('angenommen');
  return germanText(result.message as Message);
}

describe('inspectUpload', () => {
  it('nimmt Zertifikat mit Kette und Schlüssel und nennt, was es abdeckt', () => {
    const upload = ok(`${LEAF_CERT}\n${CA_CERT}`, LEAF_KEY);
    expect(upload.mainDomain).toBe('app.example.org');
    expect(upload.domains).toEqual(['app.example.org', 'www.example.org']);
    expect(upload.file).toBe('app.example.org.pem');
    expect(upload.issuer).toBe('HAPM Test CA');
    expect(Date.parse(upload.notAfter)).toBe(LEAF_NOT_AFTER);
  });

  it('schreibt Zertifikat, Kette und Schlüssel in dieser Reihenfolge, der Schlüssel als PKCS#8', () => {
    const { pem } = ok(`${LEAF_CERT}\n${CA_CERT}`, LEAF_KEY);
    const blocks = pem.match(/-----BEGIN [A-Z ]+-----/g);
    expect(blocks).toEqual(['-----BEGIN CERTIFICATE-----', '-----BEGIN CERTIFICATE-----', '-----BEGIN PRIVATE KEY-----']);
    // Das erste Zertifikat der Datei ist das der Domain: so liest HAProxy sie.
    expect(new X509Certificate(pem).subject).toContain('CN=app.example.org');
    // Und der Schlüssel darin ist derselbe.
    expect(new X509Certificate(pem).checkPrivateKey(createPrivateKey(pem))).toBe(true);
    expect(pem.endsWith('\n')).toBe(true);
  });

  it('stellt das Zertifikat zum Schlüssel nach vorn, wenn die Kette davor steht', () => {
    const { pem } = ok(`${CA_CERT}\n${LEAF_CERT}`, LEAF_KEY);
    expect(new X509Certificate(pem).subject).toContain('CN=app.example.org');
  });

  it('nimmt eine fertige PEM-Datei mit dem Schlüssel im selben Feld', () => {
    expect(ok(`${LEAF_CERT}\n${CA_CERT}\n${LEAF_KEY}`, '').mainDomain).toBe('app.example.org');
  });

  it('nimmt den CN, wenn das Zertifikat keine SANs trägt', () => {
    const upload = ok(CN_ONLY_CERT, CN_ONLY_KEY);
    expect(upload.domains).toEqual(['legacy.example.org']);
  });

  it('lehnt einen Schlüssel ab, der zu keinem Zertifikat gehört', () => {
    expect(refused(LEAF_CERT, OTHER_KEY)).toContain('gehört zu keinem');
  });

  it('lehnt einen verschlüsselten Schlüssel ab, HAProxy fragt nach keinem Passwort', () => {
    expect(refused(LEAF_CERT, LEAF_KEY_ENCRYPTED)).toContain('verschlüsselt');
  });

  it('lehnt ein abgelaufenes und ein noch nicht gültiges Zertifikat ab', () => {
    expect(refused(LEAF_CERT, LEAF_KEY, LEAF_NOT_AFTER + 1000)).toContain('abgelaufen');
    expect(refused(LEAF_CERT, LEAF_KEY, LEAF_NOT_BEFORE - 24 * 60 * 60 * 1000)).toContain('erst ab');
  });

  it('lehnt eine Kette ab, die das Zertifikat nicht ausgestellt hat', () => {
    expect(refused(`${LEAF_CERT}\n${CN_ONLY_CERT}`, LEAF_KEY)).toContain('Kette');
  });

  it('verlangt beides und sagt, was fehlt', () => {
    expect(refused('', LEAF_KEY)).toContain('Zertifikat');
    expect(refused('kein PEM', LEAF_KEY)).toContain('BEGIN CERTIFICATE');
    expect(refused(LEAF_CERT, '')).toContain('private Schlüssel');
    expect(refused(LEAF_CERT, `${LEAF_KEY}\n${OTHER_KEY}`)).toContain('mehr als ein');
  });

  it('lehnt Kaputtes ab, statt zu werfen', () => {
    expect(refused('-----BEGIN CERTIFICATE-----\nkaputt\n-----END CERTIFICATE-----', LEAF_KEY)).toContain('nicht lesen');
    expect(refused(LEAF_CERT, '-----BEGIN PRIVATE KEY-----\nkaputt\n-----END PRIVATE KEY-----')).toContain('nicht lesen');
  });
});

describe('auf der Platte', () => {
  const acme = (mainDomain: string, createdAt: string | null = '2026-10-01'): AcmeCertificate => ({
    mainDomain,
    domains: [mainDomain],
    keyLength: 'ec-256',
    createdAt,
    renewAt: null,
  });

  it('liest je Datei nur das erste Zertifikat, nie den Schlüssel', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hapm-certs-'));
    try {
      writeFileSync(join(dir, 'app.example.org.pem'), ok(`${LEAF_CERT}\n${CA_CERT}`, LEAF_KEY).pem);
      writeFileSync(join(dir, 'notiz.txt'), 'kein Zertifikat');
      const out = execFileSync('bash', ['-c', certListingCommand(dir)], { encoding: 'utf8' });
      expect(out).not.toContain('PRIVATE KEY');
      const listing = parseCertListing(out);
      expect(listing.map((entry) => entry.file)).toEqual(['app.example.org.pem']);
      expect(listing[0].pem.match(/BEGIN CERTIFICATE/g)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ein leeres Verzeichnis ergibt eine leere Liste, keinen Fehler', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hapm-certs-'));
    try {
      expect(parseCertListing(execFileSync('bash', ['-c', certListingCommand(dir)], { encoding: 'utf8' }))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hochgeladen ist, was weder Platzhalter noch von acme.sh ist', () => {
    const listing = [
      { file: FALLBACK_PEM_NAME, pem: CN_ONLY_CERT },
      { file: 'app.example.org.pem', pem: LEAF_CERT },
      { file: 'legacy.example.org.pem', pem: CN_ONLY_CERT },
      { file: '_.kunde.example.pem', pem: CN_ONLY_CERT },
    ];
    const uploaded = uploadedCertificates(listing, [acme('legacy.example.org'), acme('*.kunde.example', null)]);
    // Der Platzhalter gehört niemandem, legacy führt acme.sh. Ein gescheiterter
    // Antrag (kein Ausstellungsdatum) macht eine Datei unter seinem Namen nicht zu seiner.
    expect(uploaded.map((cert) => cert.file)).toEqual(['_.kunde.example.pem', 'app.example.org.pem']);
    expect(uploaded[1].domains).toEqual(['app.example.org', 'www.example.org']);
  });

  it('eine unlesbare Datei steht da, deckt aber nichts ab', () => {
    const [cert] = uploadedCertificates([{ file: 'kaputt.pem', pem: 'kaputt' }], []);
    expect(cert).toMatchObject({ file: 'kaputt.pem', mainDomain: null, notAfter: null, domains: [] });
    expect(uploadedCoverage([cert], NOW)).toEqual([]);
  });

  it('findCertificateFor findet ein gültiges hochgeladenes, ein abgelaufenes nicht', () => {
    const uploaded = uploadedCertificates([{ file: 'app.example.org.pem', pem: LEAF_CERT }], []);
    expect(findCertificateFor(uploadedCoverage(uploaded, NOW), ['www.example.org'])?.mainDomain).toBe('app.example.org');
    // Abgelaufen beantragt HAPM lieber neu, als für immer nichts zu tun.
    expect(findCertificateFor(uploadedCoverage(uploaded, LEAF_NOT_AFTER + 1000), ['www.example.org'])).toBeNull();
  });

  it('fasst nur Dateinamen an, wie pemFileName sie bildet', () => {
    expect(isPemFileName('app.example.org.pem')).toBe(true);
    expect(isPemFileName('_.kunde.example.pem')).toBe(true);
    expect(isPemFileName('../haproxy.cfg')).toBe(false);
    expect(isPemFileName('a/b.pem')).toBe(false);
    expect(isPemFileName('app.example.org.pem.hapm-removing')).toBe(false);
    expect(isPemFileName('.versteckt.pem')).toBe(false);
  });
});

/* ── Was HAProxy lädt ──
 *
 * Die Lage des Fehlerbilds: ein Antrag auf `huether.tech, *.huether.tech`, der
 * nie durchkam (acme.sh führt ihn ohne Ausstellungsdatum, die Seite zeigte
 * „Erneuerung —"), daneben drei Ziele mit eigenem Zertifikat. HAProxy lädt
 * die drei Dateien und keine Wildcard; „Benutzt von" stand trotzdem bei ihr. */
describe('servedFiles', () => {
  const issued = (mainDomain: string, domains = [mainDomain]): AcmeCertificate => ({
    mainDomain,
    domains,
    keyLength: 'ec-256',
    createdAt: '2026-10-25T10:00:00Z',
    renewAt: '2027-01-23T10:00:00Z',
  });
  const failedWildcard: AcmeCertificate = {
    mainDomain: 'huether.tech',
    domains: ['huether.tech', '*.huether.tech'],
    keyLength: 'ec-256',
    createdAt: null,
    renewAt: null,
  };
  const acme = [
    issued('hapm.huether.tech'),
    failedWildcard,
    issued('truenas.huether.tech'),
    issued('unifi.huether.tech'),
  ];
  const deployed = ['000-hapm-default.pem', 'hapm.huether.tech.pem', 'truenas.huether.tech.pem', 'unifi.huether.tech.pem'];

  it('ein nie ausgestellter Antrag hat keine Datei und bedient niemanden', () => {
    const files = servedFiles(acme, [], deployed);
    expect(files.map((f) => f.file)).toEqual(['hapm.huether.tech.pem', 'truenas.huether.tech.pem', 'unifi.huether.tech.pem']);

    const services = [
      { id: 'hapm', domains: ['hapm.huether.tech'] },
      { id: 'truenas_huether_tech', domains: ['truenas.huether.tech'] },
      { id: 'unifi_huether_tech', domains: ['unifi.huether.tech'] },
    ];
    const use = certificateUse(files, services);
    expect(files.map((f) => use.get(f)?.map((s) => s.id))).toEqual([['hapm'], ['truenas_huether_tech'], ['unifi_huether_tech']]);
  });

  it('ausgestellt, aber nicht ausgerollt, lädt HAProxy nicht', () => {
    const wildcard = issued('huether.tech', ['huether.tech', '*.huether.tech']);
    expect(servedFiles([wildcard], [], []).length).toBe(0);
    expect(servedFiles([wildcard], [], ['huether.tech.pem']).map((f) => f.file)).toEqual(['huether.tech.pem']);
  });

  it('ohne Blick ins Verzeichnis gilt das Ausgestellte als ausgerollt', () => {
    expect(servedFiles([issued('app.example.org')], [], null).map((f) => f.file)).toEqual(['app.example.org.pem']);
  });

  it('hochgeladene zählen mit, sortiert wie HAProxy das Verzeichnis liest', () => {
    const uploaded = uploadedCertificates([{ file: 'app.example.org.pem', pem: LEAF_CERT }], []);
    const files = servedFiles([issued('_x.example.org'), issued('Zeta.example.org')], uploaded, null);
    // Byte für Byte: Großbuchstaben vor dem Unterstrich vor Kleinbuchstaben.
    expect(files.map((f) => f.file)).toEqual(['Zeta.example.org.pem', '_x.example.org.pem', 'app.example.org.pem']);
  });
});
