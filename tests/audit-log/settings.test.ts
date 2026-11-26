import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/crypto', () => ({
  encrypt: (plain: string) => `enc(${plain})`,
  decrypt: (cipher: string) => cipher.replace(/^enc\(|\)$/g, ''),
}));

import { ApiError } from '@/lib/api';
import {
  auditSettingsView,
  checkCaPem,
  checkEndpointUrl,
  checkHeaderName,
  checkHeaderValue,
  mergeHttp,
  mergeSyslog,
  readRetention,
  validHost,
  type AuditSettings,
  type HttpSettings,
  type SyslogSettings,
} from '@/lib/audit-log/settings';
import { TEST_CA_PEM } from './fixtures/ca';

/**
 * Die Einstellungen der Weiterleitung, ohne Datenbank.
 *
 * Was hier durchgeht, wird zu einer Verbindung nach draußen und zu einer
 * Kopfzeile in einer Anfrage. Die Prüfungen sind deshalb eng: ein Wert mit
 * Zeilenumbruch wäre eine zweite Kopfzeile, ein Server mit Leerzeichen ein
 * Ziel, das niemand gemeint hat.
 */

const SYSLOG: SyslogSettings = {
  enabled: false,
  host: null,
  port: 6514,
  protocol: 'tls',
  framing: 'octet',
  facility: 'local0',
  appName: 'hapm',
  format: 'json',
  caPem: null,
  haproxyLog: false,
};

const HTTP: HttpSettings = { enabled: false, url: null, body: 'json', headerName: null, headerValue: null, caPem: null };

describe('Syslog', () => {
  it('übernimmt einen vollständigen Satz', () => {
    const next = mergeSyslog(SYSLOG, {
      enabled: true,
      host: ' siem.example.org ',
      port: 514,
      protocol: 'tcp',
      framing: 'newline',
      facility: 'authpriv',
      appName: 'hapm-prod',
      format: 'cef',
      haproxyLog: true,
    });
    expect(next).toMatchObject({
      enabled: true,
      host: 'siem.example.org',
      port: 514,
      protocol: 'tcp',
      framing: 'newline',
      facility: 'authpriv',
      appName: 'hapm-prod',
      format: 'cef',
      haproxyLog: true,
    });
  });

  it('lässt stehen, was im Patch fehlt', () => {
    const current = { ...SYSLOG, host: 'siem.example.org', enabled: true };
    expect(mergeSyslog(current, { port: 1514 })).toEqual({ ...current, port: 1514 });
  });

  it('lässt sich ohne Server nicht einschalten', () => {
    expect(() => mergeSyslog(SYSLOG, { enabled: true })).toThrow(ApiError);
    expect(() => mergeSyslog({ ...SYSLOG, host: 'x', enabled: true }, { host: '' })).toThrow(ApiError);
  });

  it.each([
    [{ host: 'siem example' }],
    [{ host: 'siem.example.org:514' }],
    [{ host: 'http://siem' }],
    [{ host: 'a;rm -rf b' }],
    [{ port: 0 }],
    [{ port: 70000 }],
    [{ port: 'viele' }],
    [{ protocol: 'sctp' }],
    [{ framing: 'null' }],
    [{ facility: 'kern' }],
    [{ format: 'xml' }],
    [{ appName: 'mit leerzeichen' }],
    [{ appName: 'x'.repeat(49) }],
    [{ appName: 'prüfung' }],
    [{ enabled: 'ja' }],
    [{ haproxyLog: 1 }],
    [{ caPem: 'kein zertifikat' }],
  ])('lehnt %j ab', (input) => {
    expect(() => mergeSyslog({ ...SYSLOG, host: 'siem.example.org' }, input)).toThrow(ApiError);
  });

  it('nimmt Servernamen, IPv4 und IPv6', () => {
    expect(validHost('siem.example.org')).toBe(true);
    expect(validHost('siem_01')).toBe(true);
    expect(validHost('10.0.0.5')).toBe(true);
    expect(validHost('2001:db8::1')).toBe(true);
    expect(validHost('[2001:db8::1]')).toBe(false);
    expect(validHost('')).toBe(false);
    expect(validHost('-siem')).toBe(false);
  });
});

describe('HTTP-Endpunkt', () => {
  it('verschlüsselt den Wert der Kopfzeile', () => {
    const next = mergeHttp(HTTP, {
      enabled: true,
      url: 'https://siem.example.org:8088/services/collector/event',
      body: 'hec',
      headerName: 'Authorization',
      headerValue: 'Splunk abc-123',
    });
    expect(next.headerValue).toBe('enc(Splunk abc-123)');
    expect(next.url).toBe('https://siem.example.org:8088/services/collector/event');
    expect(next.body).toBe('hec');
  });

  it('behält den gespeicherten Wert, wenn der Patch ihn nicht nennt, und entfernt ihn mit null', () => {
    const current = { ...HTTP, url: 'https://x.example', headerName: 'Authorization', headerValue: 'enc(alt)' };
    expect(mergeHttp(current, { body: 'hec' }).headerValue).toBe('enc(alt)');
    expect(mergeHttp(current, { headerValue: null }).headerValue).toBeNull();
    expect(mergeHttp(current, { headerValue: '' }).headerValue).toBeNull();
  });

  it('gibt den Wert nie zurück, nur ob er gesetzt ist', () => {
    const settings = {
      retentionDays: 365,
      syslog: SYSLOG,
      http: { ...HTTP, headerName: 'Authorization', headerValue: 'enc(geheim)' },
    } as AuditSettings;
    const view = auditSettingsView(settings);
    expect(view.http).not.toHaveProperty('headerValue');
    expect(view.http.headerValueSet).toBe(true);
    expect(JSON.stringify(view)).not.toContain('geheim');
    expect(auditSettingsView({ ...settings, http: HTTP }).http.headerValueSet).toBe(false);
  });

  it('lässt sich ohne Adresse nicht einschalten und verlangt zum Wert einen Namen', () => {
    expect(() => mergeHttp(HTTP, { enabled: true })).toThrow(ApiError);
    expect(() => mergeHttp(HTTP, { url: 'https://x.example', headerValue: 'Bearer x' })).toThrow(ApiError);
  });

  it.each([
    'ftp://siem.example.org/',
    'siem.example.org',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'https://user:pass@siem.example.org/',
    `https://siem.example.org/${'x'.repeat(500)}`,
  ])('lehnt die Adresse %s ab', (url) => {
    expect('error' in checkEndpointUrl(url)).toBe(true);
  });

  it('nimmt http und https und wirft den Anker weg', () => {
    expect(checkEndpointUrl('http://10.0.0.5:9000/hook')).toEqual({ url: 'http://10.0.0.5:9000/hook' });
    expect(checkEndpointUrl('https://siem.example.org/in#teil')).toEqual({ url: 'https://siem.example.org/in' });
  });

  it('lässt im Namen der Kopfzeile nur zu, was dort stehen darf', () => {
    expect(checkHeaderName('Authorization')).toBeNull();
    expect(checkHeaderName('X-Api-Key')).toBeNull();
    expect(checkHeaderName('X Api Key')).not.toBeNull();
    expect(checkHeaderName('X-Key:')).not.toBeNull();
    expect(checkHeaderName('X-Key\r\nX-Other')).not.toBeNull();
    expect(checkHeaderName('Host')).not.toBeNull();
    expect(checkHeaderName('content-length')).not.toBeNull();
  });

  it('lässt im Wert keinen Zeilenumbruch zu: das wäre eine zweite Kopfzeile', () => {
    expect(checkHeaderValue('Splunk 0a1b2c3d-4e5f')).toBeNull();
    expect(checkHeaderValue('Bearer x\r\nX-Injected: 1')).not.toBeNull();
    expect(checkHeaderValue('Bearer x\ny')).not.toBeNull();
    expect(checkHeaderValue('Bearer ü')).not.toBeNull();
    expect(checkHeaderValue('x'.repeat(2001))).not.toBeNull();
  });
});

describe('CA-Zertifikat', () => {
  it('nimmt ein lesbares Zertifikat und bringt es in eine Form', () => {
    const checked = checkCaPem(`\r\n${TEST_CA_PEM.replace(/\n/g, '\r\n')}\r\n`);
    expect('pem' in checked && checked.pem).toBe(`${TEST_CA_PEM.trim()}\n`);
  });

  it('nimmt mehrere Zertifikate hintereinander', () => {
    const checked = checkCaPem(`${TEST_CA_PEM}\n${TEST_CA_PEM}`);
    expect('pem' in checked && checked.pem.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
  });

  it.each([
    ['Text ohne PEM', 'hallo'],
    ['ein privater Schlüssel', '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----'],
    ['ein kaputtes Zertifikat', '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----'],
    ['Text neben dem Zertifikat', `${TEST_CA_PEM}\nund noch etwas`],
  ])('lehnt %s ab', (_what, value) => {
    expect('error' in checkCaPem(value)).toBe(true);
  });

  it('wird in den Einstellungen zu null, wenn das Feld leer ist', () => {
    expect(mergeSyslog({ ...SYSLOG, caPem: 'alt' }, { caPem: '' }).caPem).toBeNull();
    expect(mergeHttp({ ...HTTP, caPem: 'alt' }, { caPem: null }).caPem).toBeNull();
  });
});

describe('Aufbewahrung', () => {
  it('nimmt 30 bis 3650 Tage', () => {
    expect(readRetention(30)).toBe(30);
    expect(readRetention('365')).toBe(365);
    expect(readRetention(3650)).toBe(3650);
  });

  it.each([29, 3651, 0, -1, 90.5, 'lang', null])('lehnt %j ab', (value) => {
    expect(() => readRetention(value)).toThrow(ApiError);
  });
});
