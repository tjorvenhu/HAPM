import { describe, expect, it } from 'vitest';
import {
  infobloxAccess,
  normalizePem,
  packAccess,
  readInfobloxAccess,
  readRfc2136Access,
  rfc2136Access,
  tsigKeyFile,
  validateInfoblox,
  validateRfc2136,
  type InfobloxInput,
  type Rfc2136Input,
} from '@/lib/dns/access';

/**
 * Der Zugang zu einem eigenen Nameserver und zu Infoblox: was als Eingabe
 * durchgeht, wie er als Text gespeichert und wieder gelesen wird.
 *
 * Was dieselben Werte bei acme.sh anrichten könnten, rechnet
 * `tests/haproxy/dns-credentials.test.ts` mit einer echten Shell nach.
 */

const SECRET = 'c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LTEyMzQ=';

const nameserver = (over: Partial<Rfc2136Input> = {}): Rfc2136Input => ({
  server: 'ns1.example.org',
  port: '',
  keyName: 'hapm-key',
  algorithm: '',
  secret: SECRET,
  ...over,
});

const appliance = (over: Partial<InfobloxInput> = {}): InfobloxInput => ({
  server: 'infoblox.example.org',
  username: 'hapm',
  password: 'geh3im!',
  view: '',
  wapiVersion: '',
  ca: '',
  ...over,
});

const PEM = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ0Fh\n-----END CERTIFICATE-----';

describe('RFC 2136', () => {
  it('setzt die Vorgaben ein: Port 53 und HMAC-SHA256', () => {
    expect(validateRfc2136(nameserver())).toBeNull();
    expect(rfc2136Access(nameserver({ server: ' NS1.Example.org ', keyName: 'HAPM-Key.' }))).toEqual({
      server: 'ns1.example.org',
      port: 53,
      keyName: 'hapm-key',
      algorithm: 'hmac-sha256',
      secret: SECRET,
    });
    expect(rfc2136Access(nameserver({ port: '5353', algorithm: 'hmac-sha512' }))).toMatchObject({
      port: 5353,
      algorithm: 'hmac-sha512',
    });
  });

  it('nimmt Namen, IPv4 und IPv6 als Nameserver', () => {
    for (const server of ['ns1', 'ns1.example.org', '192.0.2.53', '2001:db8::53', '::1']) {
      expect(validateRfc2136(nameserver({ server })), server).toBeNull();
    }
    for (const server of ['', 'ns1.example.org:53', 'ns1 example', '-ns1', 'ns1/x', 'ns1;x']) {
      expect(validateRfc2136(nameserver({ server })), server).not.toBeNull();
    }
  });

  it('bietet HMAC-MD5 und HMAC-SHA1 nicht an', () => {
    expect(validateRfc2136(nameserver({ algorithm: 'hmac-md5' }))).not.toBeNull();
    expect(validateRfc2136(nameserver({ algorithm: 'hmac-sha1' }))).not.toBeNull();
    expect(validateRfc2136(nameserver({ algorithm: 'hmac-sha384' }))).toBeNull();
  });

  it('verlangt ein Geheimnis, das Base64 ist und lang genug', () => {
    for (const secret of ['', 'kein base64!', 'YWJj', 'YWJjZGVmZ2hpamtsbW5vcA', `${SECRET}x`]) {
      expect(validateRfc2136(nameserver({ secret })), secret).not.toBeNull();
    }
    // Genau 16 Bytes.
    expect(validateRfc2136(nameserver({ secret: 'YWJjZGVmZ2hpamtsbW5vcA==' }))).toBeNull();
  });

  it('schreibt die Schlüsseldatei in der Form von tsig-keygen', () => {
    expect(tsigKeyFile(rfc2136Access(nameserver()))).toBe(
      `key "hapm-key" {\n\talgorithm hmac-sha256;\n\tsecret "${SECRET}";\n};\n`
    );
  });

  it('liest den gespeicherten Zugang wieder und hält Unsinn nicht für einen', () => {
    const access = rfc2136Access(nameserver({ port: '5353' }));
    expect(readRfc2136Access(packAccess(access))).toEqual(access);
    expect(readRfc2136Access('ein-api-token')).toBeNull();
    expect(readRfc2136Access('[]')).toBeNull();
    expect(readRfc2136Access(JSON.stringify({ ...access, secret: 'x' }))).toBeNull();
    expect(readRfc2136Access(JSON.stringify({ ...access, server: "x'; id" }))).toBeNull();
  });
});

describe('Infoblox', () => {
  it('setzt die Vorgaben ein: View default und die Fassung des acme.sh-Hooks', () => {
    expect(validateInfoblox(appliance())).toBeNull();
    expect(infobloxAccess(appliance({ server: ' Infoblox.Example.org ' }))).toEqual({
      server: 'infoblox.example.org',
      username: 'hapm',
      password: 'geh3im!',
      view: 'default',
      wapiVersion: '2.2.2',
      ca: null,
    });
    expect(infobloxAccess(appliance({ view: 'Interne Sicht', wapiVersion: 'v2.12' }))).toMatchObject({
      view: 'Interne Sicht',
      wapiVersion: '2.12',
    });
  });

  it('nimmt als Adresse einen Namen, wahlweise mit Port, und nichts mit Schema oder Pfad', () => {
    for (const server of ['infoblox', 'gm.example.org', 'gm.example.org:8443', '192.0.2.5']) {
      expect(validateInfoblox(appliance({ server })), server).toBeNull();
    }
    for (const server of ['', 'https://gm.example.org', 'gm.example.org/wapi', 'gm.example.org:99999', 'gm example']) {
      expect(validateInfoblox(appliance({ server })), server).not.toBeNull();
    }
  });

  it('lässt im Passwort alles zu außer dem, was acme.sh nicht ablegen kann', () => {
    expect(validateInfoblox(appliance({ password: 'p@ss"w$rd&|;`#%(x)!' }))).toBeNull();
    for (const password of ['', "mit'apostroph", 'mit\\backslash', 'mit leerzeichen', 'zeilen\numbruch', 'umläut']) {
      expect(validateInfoblox(appliance({ password })), password).not.toBeNull();
    }
  });

  it('trennt Benutzer und Passwort am ersten Doppelpunkt: der Benutzer trägt keinen', () => {
    expect(validateInfoblox(appliance({ username: 'ha:pm' }))).not.toBeNull();
    expect(validateInfoblox(appliance({ password: 'mit:doppelpunkt' }))).toBeNull();
  });

  it('nimmt als CA nur Zertifikate, einheitlich umbrochen', () => {
    expect(normalizePem(`\r\n  ${PEM.replace(/\n/g, '\r\n')}  \r\n`)).toBe(`${PEM}\n`);
    expect(normalizePem(`${PEM}\n${PEM}`)).toBe(`${PEM}\n${PEM}\n`);
    expect(normalizePem('')).toBeNull();
    expect(normalizePem('kein pem')).toBeNull();
    // Ein privater Schlüssel hat hier nichts verloren.
    expect(normalizePem(`${PEM}\n-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----`)).toBeNull();
    expect(infobloxAccess(appliance({ ca: PEM })).ca).toBe(`${PEM}\n`);
    expect(validateInfoblox(appliance({ ca: 'kein pem' }))).not.toBeNull();
  });

  it('liest den gespeicherten Zugang wieder', () => {
    const access = infobloxAccess(appliance({ ca: PEM, view: 'Intern' }));
    expect(readInfobloxAccess(packAccess(access))).toEqual(access);
    expect(readInfobloxAccess('ein-api-token')).toBeNull();
    expect(readInfobloxAccess(JSON.stringify({ ...access, password: '' }))).toBeNull();
  });
});
