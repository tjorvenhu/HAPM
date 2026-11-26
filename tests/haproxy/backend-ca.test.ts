import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CA_WARN_DAYS,
  caDaysLeft,
  caListingCommand,
  caReferenced,
  caUsers,
  inspectCaUpload,
  listedCas,
  normalizeCaName,
  parseCaListing,
  validateCaName,
  type InspectedCa,
} from '@/lib/haproxy/backend-ca';
import {
  BACKEND_CA_DIR,
  addService,
  backendCaFile,
  backendCaName,
  backendCaTls,
  backendTlsKind,
  caNameFromFile,
  isBackendTls,
  isValidCaName,
  parseHaproxyConfig,
  usedBackendCas,
  type CreateServiceInput,
} from '@/lib/haproxy/config';
import { germanText } from '@/lib/i18n/translate';
import { CA_CERT, LEAF_CERT, LEAF_KEY } from './fixtures/upload-certs';
import {
  EXPIRED_ROOT_CERT,
  ISSUING_CERT,
  ISSUING_NOT_AFTER,
  PINNED_CERT,
  ROOT_CERT,
  ROOT_NOT_AFTER,
  SERVER_CERT,
} from './fixtures/ca-certs';

/**
 * Hinterlegte Zertifizierungsstellen: was beim Hochladen geprüft wird, bevor
 * etwas auf die Platte geht, wie eine Datei dort wiedererkannt wird und wann
 * sie als benutzt gilt.
 *
 * Der teure Fehler wäre eine Datei, die HAProxy nicht lädt oder mit der es
 * jedes Ziel ablehnt: das fiele erst auf, wenn ein Ziel sie benutzt, und dann
 * an der ganzen Konfiguration. Ob HAProxy die Datei annimmt und damit wirklich
 * prüft, zeigt `pnpm haproxy:verify-tls` mit Docker.
 */

const NOW = Date.parse('2027-01-01T00:00:00Z');

function ok(name: string, certificate: string, now = NOW): InspectedCa {
  const result = inspectCaUpload({ name, certificate }, now);
  if (!result.ok) throw new Error(germanText(result.message));
  return result.value;
}

function refused(name: string, certificate: string, now = NOW): string {
  const result = inspectCaUpload({ name, certificate }, now);
  if (result.ok) throw new Error('angenommen');
  return germanText(result.message);
}

describe('der Name', () => {
  it('ist eng: er wird Dateiname und Wort einer server-Zeile', () => {
    for (const name of ['intern-root', 'ca1', 'a', 'x'.repeat(40)]) expect(isValidCaName(name), name).toBe(true);
    for (const name of [
      '',
      'Intern',
      'intern root',
      'intern_root',
      'intern.root',
      '../etc',
      'a/b',
      '-intern',
      'intern-',
      'x'.repeat(41),
      'ä',
      'a\nb',
      "a'b",
      'a;b',
    ]) {
      expect(isValidCaName(name), JSON.stringify(name)).toBe(false);
    }
  });

  it('wird beim Hochladen kleingeschrieben und von Leerraum befreit', () => {
    expect(normalizeCaName('  Intern-Root ')).toBe('intern-root');
    expect(ok(' Intern-Root ', ROOT_CERT).name).toBe('intern-root');
  });

  it('sagt, was an ihm falsch ist', () => {
    expect(validateCaName('intern-root')).toBeNull();
    expect(germanText(validateCaName('')!)).toContain('einen Namen');
    expect(germanText(validateCaName('intern root')!)).toContain('Kleinbuchstaben');
    expect(refused('../etc/passwd', ROOT_CERT)).toContain('Kleinbuchstaben');
  });

  it('ergibt genau einen Pfad, und nur der führt zurück', () => {
    expect(backendCaFile('intern-root')).toBe('/etc/haproxy/hapm-ca/intern-root.pem');
    expect(caNameFromFile('/etc/haproxy/hapm-ca/intern-root.pem')).toBe('intern-root');
    for (const file of [
      '@system-ca',
      '/etc/ssl/intern.pem',
      '/etc/haproxy/hapm-ca/intern-root.crt',
      '/etc/haproxy/hapm-ca/../certs/x.pem',
      '/etc/haproxy/hapm-ca/Intern.pem',
      '/etc/haproxy/hapm-ca/a/b.pem',
      'hapm-ca/intern-root.pem',
    ]) {
      expect(caNameFromFile(file), file).toBeNull();
    }
  });

  it('steht im Wert von backendTls und nicht in einem zweiten Feld', () => {
    expect(backendCaTls('intern-root')).toBe('ca:intern-root');
    expect(backendCaName('ca:intern-root')).toBe('intern-root');
    expect(backendCaName('verify')).toBeNull();
    expect(backendTlsKind('ca:intern-root')).toBe('ca');
    expect(backendTlsKind('verify')).toBe('verify');
    for (const value of ['off', 'insecure', 'verify', 'ca:intern-root']) expect(isBackendTls(value), value).toBe(true);
    for (const value of ['ca:', 'ca:Intern', 'ca:../x', 'ca:a b', 'ca', 'strict', '', null, 3]) {
      expect(isBackendTls(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe('inspectCaUpload', () => {
  it('nimmt eine Root und nennt Inhaber, Ablauf und Fingerabdruck', () => {
    const upload = ok('intern-root', ROOT_CERT);
    expect(upload.file).toBe('/etc/haproxy/hapm-ca/intern-root.pem');
    expect(upload.certificates).toHaveLength(1);
    expect(upload.certificates[0]).toMatchObject({
      subject: 'Example Internal Root',
      issuer: 'Example Internal Root',
      notAfter: ROOT_NOT_AFTER,
      selfSigned: true,
      ca: true,
    });
    expect(upload.certificates[0].fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(upload.notAfter).toBe(ROOT_NOT_AFTER);
    expect(upload.warnings).toEqual([]);
  });

  it('nimmt ein Bündel aus Root und Zwischenstelle, der früheste Ablauf zählt', () => {
    const upload = ok('intern', `${ISSUING_CERT}\n${ROOT_CERT}\n`);
    expect(upload.certificates.map((cert) => cert.subject)).toEqual(['Example Issuing CA', 'Example Internal Root']);
    expect(upload.certificates[0]).toMatchObject({ issuer: 'Example Internal Root', selfSigned: false, ca: true });
    expect(upload.notAfter).toBe(ISSUING_NOT_AFTER);
    expect(upload.warnings).toEqual([]);
  });

  it('schreibt jedes Zertifikat einmal, als PEM und ohne den Text drumherum', () => {
    const upload = ok('intern', `Unsere Root:\n${ROOT_CERT}\n\n# Zwischenstelle\n${ISSUING_CERT}\n${ROOT_CERT}\n`);
    expect(upload.certificates).toHaveLength(2);
    expect(upload.pem.match(/-----BEGIN CERTIFICATE-----/g)).toHaveLength(2);
    expect(upload.pem).not.toContain('Unsere Root');
    expect(upload.pem).not.toContain('#');
    expect(upload.pem.endsWith('-----END CERTIFICATE-----\n')).toBe(true);
    // Was geschrieben wird, liest dieselbe Prüfung wieder genauso.
    expect(ok('intern', upload.pem).certificates).toEqual(upload.certificates);
  });

  it('lehnt einen privaten Schlüssel ab, auch neben einem gültigen Zertifikat', () => {
    expect(refused('intern', `${ROOT_CERT}\n${LEAF_KEY}`)).toContain('privater Schlüssel');
    expect(refused('intern', LEAF_KEY)).toContain('privater Schlüssel');
  });

  it('lehnt ab, was kein PEM-Zertifikat ist', () => {
    expect(refused('intern', '')).toContain('fügen Sie das Zertifikat');
    expect(refused('intern', 'MIIB...')).toContain('kein PEM-Zertifikat');
    expect(refused('intern', '-----BEGIN CERTIFICATE-----\nkaputt\n-----END CERTIFICATE-----')).toContain('nicht lesen');
    expect(refused('intern', 'x'.repeat(300_001))).toContain('300 KB');
  });

  it('lehnt das Zertifikat eines Servers ab, das eine CA ausgestellt hat, und nennt die Stelle', () => {
    const message = refused('intern', SERVER_CERT);
    expect(message).toContain('app.intern.example');
    expect(message).toContain('Example Issuing CA');
    // Auch im Bündel: HAProxy prüfte damit nichts, und die Liste behauptete es.
    expect(refused('intern', `${ROOT_CERT}\n${SERVER_CERT}`)).toContain('keine Zertifizierungsstelle');
  });

  it('nimmt ein selbst signiertes Zertifikat eines Servers und sagt, was das heißt', () => {
    const upload = ok('nas', PINNED_CERT);
    expect(upload.certificates[0]).toMatchObject({ subject: 'nas.intern.example', selfSigned: true, ca: false });
    expect(upload.warnings.map(germanText).join(' ')).toContain('genau dieses Zertifikat');
  });

  it('nimmt eine Root der Fassung 1 als Zertifizierungsstelle, wie OpenSSL', () => {
    // Ohne Erweiterungen gibt es kein CA:TRUE. Selbst signiert gilt sie trotzdem als CA.
    const upload = ok('alt', CA_CERT);
    expect(upload.certificates[0]).toMatchObject({ subject: 'HAPM Test CA', selfSigned: true, ca: true });
    expect(upload.warnings).toEqual([]);
    // Das Zertifikat darunter bleibt, was es ist.
    expect(refused('alt', LEAF_CERT)).toContain('keine Zertifizierungsstelle');
  });

  it('lehnt ein abgelaufenes Zertifikat ab', () => {
    expect(refused('alt', EXPIRED_ROOT_CERT)).toContain('seit dem 2025-01-01 abgelaufen');
    expect(refused('intern', ROOT_CERT, Date.parse('2037-01-01T00:00:00Z'))).toContain('abgelaufen');
  });

  it('lehnt auch ein Bündel ab, in dem eines abgelaufen ist, und nennt es', () => {
    // Die Liste zeigte die Stelle sonst ab dem ersten Tag als abgelaufen: der früheste Ablauf zählt.
    const message = refused('intern', `${ROOT_CERT}\n${EXPIRED_ROOT_CERT}`);
    expect(message).toContain('„Example Old Root" in der Datei ist seit dem 2025-01-01 abgelaufen');
    expect(message).toContain('Nehmen Sie es heraus');
    // Die Zwischenstelle läuft vor der Root ab: danach geht das Bündel nicht mehr durch.
    expect(refused('intern', `${ROOT_CERT}\n${ISSUING_CERT}`, Date.parse('2032-01-01T00:00:00Z'))).toContain('Example Issuing CA');
  });

  it('lehnt ab, was noch nicht gilt', () => {
    expect(refused('intern', ROOT_CERT, Date.parse('2026-01-01T00:00:00Z'))).toContain('gilt erst ab dem 2026-11-25');
  });
});

describe('auf der Platte', () => {
  const listing = [
    { file: 'intern.pem', pem: `${ISSUING_CERT}\n${ROOT_CERT}` },
    { file: 'alt.pem', pem: EXPIRED_ROOT_CERT },
    { file: 'kaputt.pem', pem: 'kein Zertifikat' },
    // Kein Name, den HAPM vergibt: nicht angefasst und nicht gezeigt.
    { file: 'Fremd.pem', pem: ROOT_CERT },
    { file: 'notiz.txt', pem: ROOT_CERT },
    { file: 'a.b.pem', pem: ROOT_CERT },
  ];

  it('zählt nur Dateien mit einem Namen von HAPM, nach Namen sortiert', () => {
    expect(listedCas(listing).map((ca) => ca.name)).toEqual(['alt', 'intern', 'kaputt']);
  });

  it('liest jedes Zertifikat der Datei und den frühesten Ablauf', () => {
    const intern = listedCas(listing).find((ca) => ca.name === 'intern')!;
    expect(intern.file).toBe('/etc/haproxy/hapm-ca/intern.pem');
    expect(intern.certificates.map((cert) => cert.subject)).toEqual(['Example Issuing CA', 'Example Internal Root']);
    expect(intern.notAfter).toBe(ISSUING_NOT_AFTER);
  });

  it('nennt eine unlesbare Datei, mit unbekanntem Ablauf statt „abgelaufen"', () => {
    const broken = listedCas(listing).find((ca) => ca.name === 'kaputt')!;
    expect(broken.certificates).toEqual([]);
    expect(broken.notAfter).toBeNull();
    expect(caDaysLeft(broken, NOW)).toBeNull();
  });

  it('rechnet die Tage bis zum Ablauf, negativ nach dem Ablauf', () => {
    const [old, intern] = listedCas(listing);
    expect(caDaysLeft(old, NOW)).toBeLessThan(0);
    expect(caDaysLeft(intern, Date.parse(ISSUING_NOT_AFTER) - 10.5 * 86_400_000)).toBe(10);
    expect(CA_WARN_DAYS).toBe(30);
  });

  it('liest die Dateien mit einer echten Shell, ganz und je mit ihrem Namen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hapm-ca-'));
    try {
      const cas = join(dir, 'hapm-ca');
      mkdirSync(cas);
      writeFileSync(join(cas, 'intern.pem'), `${ISSUING_CERT}\n${ROOT_CERT}\n`);
      // Ohne Zeilenende: die nächste Marke darf nicht an der letzten Zeile kleben.
      writeFileSync(join(cas, 'alt.pem'), EXPIRED_ROOT_CERT);
      writeFileSync(join(cas, 'notiz.txt'), 'nicht gelesen');
      const posix = cas.replace(/\\/g, '/');
      const out = execFileSync('bash', ['-c', caListingCommand(posix)], { encoding: 'utf8' });
      const read = listedCas(parseCaListing(out));
      expect(read.map((ca) => [ca.name, ca.certificates.length])).toEqual([
        ['alt', 1],
        ['intern', 2],
      ]);
      // Ein Ordner, den es nicht gibt, ist eine leere Liste und kein Fehler.
      expect(execFileSync('bash', ['-c', caListingCommand(`${posix}/fehlt`)], { encoding: 'utf8' })).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('baut den Ordner sicher in das Kommando ein', () => {
    expect(caListingCommand("/tmp/a'b")).toContain(`'/tmp/a'\\''b'/*.pem`);
  });
});

describe('wer eine Zertifizierungsstelle benutzt', () => {
  const CONFIG = `frontend https_in
    bind :443 ssl crt /etc/haproxy/certs/

# END AUTO INTERN SERVICES

# END AUTO INTERN BACKENDS
`;
  const input = (over: Partial<CreateServiceInput>): CreateServiceInput => ({
    scope: 'INTERN',
    id: 'app',
    domains: ['app.example.org'],
    servers: [{ name: '', target: '10.0.0.5:8443', weight: null }],
    redirect: null,
    routes: [],
    balance: null,
    sticky: false,
    lockedDomains: [],
    passwordLock: null,
    responseHeaders: [],
    requestHeaders: [],
    tunnel: false,
    crowdsec: false,
    app: null,
    healthcheck: true,
    backendTls: 'off',
    ...over,
  });

  let text = addService(CONFIG, input({ backendTls: 'ca:intern' }));
  text = addService(text, input({ id: 'oeffentlich', domains: ['www.example.org'], backendTls: 'verify' }));
  text = addService(
    text,
    input({
      id: 'regel',
      domains: ['regel.example.org'],
      routes: [{ name: 'api', paths: ['/api'], servers: [{ name: '', target: '10.0.0.6:8443' }], check: false, backendTls: 'ca:zweite' }],
    })
  );
  const services = parseHaproxyConfig(text);

  it('nennt das Ziel mit der Stelle im Backend und das mit ihr in einer Pfad-Regel', () => {
    expect(caUsers('intern', services).map((service) => service.id)).toEqual(['app']);
    expect(caUsers('zweite', services).map((service) => service.id)).toEqual(['regel']);
    expect(caUsers('dritte', services)).toEqual([]);
  });

  it('nennt jede Stelle einer Eingabe einmal', () => {
    expect(
      usedBackendCas(
        input({
          backendTls: 'ca:intern',
          routes: [
            { name: 'a', paths: ['/a'], servers: [], check: false, backendTls: 'ca:intern' },
            { name: 'b', paths: ['/b'], servers: [], check: false, backendTls: 'ca:zweite' },
            { name: 'c', paths: ['/c'], servers: [], check: false, backendTls: 'verify' },
          ],
        })
      )
    ).toEqual(['intern', 'zweite']);
    expect(usedBackendCas(input({ backendTls: 'verify' }))).toEqual([]);
  });

  it('gilt als benutzt, sobald haproxy.cfg die Datei nennt, auch in einer Zeile von Hand', () => {
    expect(caReferenced('intern', text)).toBe(true);
    expect(caReferenced('zweite', text)).toBe(true);
    expect(caReferenced('dritte', text)).toBe(false);
    const byHand = `${CONFIG}\nbackend von_hand\n    server s 10.0.0.9:443 ssl verify required ca-file ${BACKEND_CA_DIR}/dritte.pem verifyhost x.lan\n`;
    expect(caReferenced('dritte', byHand)).toBe(true);
    expect(caUsers('dritte', parseHaproxyConfig(byHand))).toEqual([]);
  });

  it('zählt weder einen Kommentar noch einen Namen, der nur so anfängt', () => {
    const commented = `${CONFIG}\n    # server s 10.0.0.9:443 ssl verify required ca-file ${BACKEND_CA_DIR}/dritte.pem\n`;
    expect(caReferenced('dritte', commented)).toBe(false);
    expect(caReferenced('inter', text)).toBe(false);
    expect(caReferenced('intern-2', text)).toBe(false);
  });
});
