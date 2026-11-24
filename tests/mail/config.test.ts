import { describe, expect, it } from 'vitest';
import {
  MailError,
  SMTP_TIMEOUTS,
  describeSmtpError,
  formatSender,
  isMailConfigured,
  parseSender,
  smtpConfig,
  smtpError,
  transportOptions,
  type MailSettings,
} from '@/lib/mail/config';

const decryptPass = (ciphertext: string) => ciphertext.replace(/^enc:/, '');

const base: MailSettings = {
  smtpHost: 'smtp.example.org',
  smtpPort: 587,
  smtpSecurity: 'starttls',
  smtpUser: 'hapm',
  smtpPass: 'enc:streng-geheim',
  mailFrom: 'hapm@example.org',
};

describe('parseSender', () => {
  it('liest eine Adresse mit und ohne Namen', () => {
    expect(parseSender('hapm@example.org')).toEqual({ name: null, address: 'hapm@example.org' });
    expect(parseSender('Proxy Büro <hapm@example.org>')).toEqual({ name: 'Proxy Büro', address: 'hapm@example.org' });
    expect(parseSender('"Proxy" <hapm@example.org>')).toEqual({ name: 'Proxy', address: 'hapm@example.org' });
    expect(parseSender('<hapm@example.org>')).toEqual({ name: null, address: 'hapm@example.org' });
  });

  it('lehnt ab, was kein Absender ist oder eine zweite Kopfzeile wäre', () => {
    expect(parseSender('')).toBeNull();
    expect(parseSender('nur ein name')).toBeNull();
    expect(parseSender('Name <keine-adresse>')).toBeNull();
    expect(parseSender('hapm@example.org\nBcc: x@example.org')).toBeNull();
  });

  it('schreibt den Absender mit dem Produktnamen, wenn keiner angegeben ist', () => {
    expect(formatSender({ name: null, address: 'hapm@example.org' })).toBe('"HAPM" <hapm@example.org>');
    expect(formatSender({ name: 'Proxy', address: 'hapm@example.org' })).toBe('"Proxy" <hapm@example.org>');
  });
});

describe('isMailConfigured', () => {
  it('verlangt Server und Absender', () => {
    expect(isMailConfigured(base)).toBe(true);
    expect(isMailConfigured({ ...base, smtpHost: null })).toBe(false);
    expect(isMailConfigured({ ...base, smtpHost: '  ' })).toBe(false);
    expect(isMailConfigured({ ...base, mailFrom: null })).toBe(false);
    expect(isMailConfigured({ ...base, mailFrom: 'kaputt' })).toBe(false);
  });

  it('verlangt weder Benutzer noch Passwort', () => {
    expect(isMailConfigured({ smtpHost: 'relay.intern', mailFrom: 'hapm@example.org' })).toBe(true);
  });
});

describe('smtpConfig', () => {
  it('entschlüsselt das Passwort und setzt den Absender zusammen', () => {
    expect(smtpConfig(base, decryptPass)).toEqual({
      host: 'smtp.example.org',
      port: 587,
      security: 'starttls',
      user: 'hapm',
      pass: 'streng-geheim',
      from: '"HAPM" <hapm@example.org>',
    });
  });

  it('wirft mit einem Satz für die Oberfläche, wenn nichts eingerichtet ist', () => {
    expect(() => smtpConfig({ ...base, smtpHost: null }, decryptPass)).toThrow(MailError);
    expect(() => smtpConfig({ ...base, mailFrom: null }, decryptPass)).toThrow('kein SMTP-Konto eingerichtet');
  });

  it('sagt, wenn sich das Passwort nicht mehr entschlüsseln lässt', () => {
    const broken = () => {
      throw new Error('Unsupported state or unable to authenticate data');
    };
    expect(() => smtpConfig(base, broken)).toThrow('lässt sich nicht entschlüsseln');
  });
});

describe('transportOptions', () => {
  const config = smtpConfig(base, decryptPass);

  it('setzt Zeitgrenzen', () => {
    expect(transportOptions(config)).toMatchObject(SMTP_TIMEOUTS);
    expect(SMTP_TIMEOUTS.connectionTimeout).toBeLessThanOrEqual(30_000);
    expect(SMTP_TIMEOUTS.socketTimeout).toBeLessThanOrEqual(60_000);
  });

  it('übersetzt die Verschlüsselung', () => {
    expect(transportOptions(config)).toMatchObject({ secure: false, requireTLS: true, ignoreTLS: false });
    expect(transportOptions({ ...config, security: 'tls' })).toMatchObject({ secure: true, requireTLS: false });
    expect(transportOptions({ ...config, security: 'none' })).toMatchObject({
      secure: false,
      requireTLS: false,
      ignoreTLS: true,
    });
  });

  it('meldet sich nur an, wenn ein Benutzer gesetzt ist', () => {
    expect(transportOptions(config).auth).toEqual({ user: 'hapm', pass: 'streng-geheim' });
    expect('auth' in transportOptions({ ...config, user: null })).toBe(false);
  });
});

describe('describeSmtpError', () => {
  const config = { host: 'smtp.example.org', port: 587, pass: 'streng-geheim' };

  it('nennt die Ursache und die Antwort des Servers', () => {
    const text = describeSmtpError({ code: 'EAUTH', response: '535 5.7.8 Authentication failed' }, config);
    expect(text).toContain('Anmeldung abgelehnt');
    expect(text).toContain('535 5.7.8 Authentication failed');
    expect(describeSmtpError({ code: 'ETIMEDOUT', message: 'Connection timeout' }, config)).toContain(
      'nicht rechtzeitig geantwortet'
    );
    expect(describeSmtpError({ code: 'EDNS', message: 'getaddrinfo ENOTFOUND' }, config)).toContain('nicht auflösen');
    expect(describeSmtpError({ code: 'ESOCKET', message: 'wrong version number' }, config)).toContain(
      'smtp.example.org:587'
    );
  });

  it('gibt das Passwort nicht weiter, auch wenn der Server es zurückschickt', () => {
    const text = describeSmtpError({ code: 'EAUTH', response: '535 falsches Passwort streng-geheim' }, config);
    expect(text).not.toContain('streng-geheim');
  });

  it('unterscheidet eine abgelehnte Mail von einem Konto, das nicht geht', () => {
    expect(smtpError({ code: 'EENVELOPE', response: '550 Unknown user' }, config).reason).toBe('rejected');
    expect(smtpError({ code: 'EAUTH' }, config).reason).toBe('unavailable');
    expect(smtpError({ code: 'ECONNECTION' }, config).reason).toBe('unavailable');
  });
});
