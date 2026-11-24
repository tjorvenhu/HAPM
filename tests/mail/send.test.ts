import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@/lib/types';

/**
 * Der Versand, ohne Netz: nodemailer ist ersetzt, die Einstellungen kommen aus
 * einer Zeile im Speicher, das Entschlüsseln ist ein Tausch von Vorsilben.
 */

const sent: Record<string, unknown>[] = [];
const transports: Record<string, unknown>[] = [];
let failWith: unknown = null;
let row: Partial<Settings> = {};

vi.mock('nodemailer', () => ({
  default: {
    createTransport: (options: Record<string, unknown>) => {
      transports.push(options);
      return {
        sendMail: async (message: Record<string, unknown>) => {
          if (failWith) throw failWith;
          sent.push(message);
          return { messageId: 'test' };
        },
        close: () => undefined,
      };
    },
  },
}));

vi.mock('@/lib/db', () => ({
  getSingleton: async () => ({ ...row, $id: 'main', $createdAt: '', $updatedAt: '' }),
  updateDocument: vi.fn(),
}));

vi.mock('@/lib/crypto', () => ({
  encrypt: (plaintext: string) => `enc:${plaintext}`,
  decrypt: (ciphertext: string) => ciphertext.replace(/^enc:/, ''),
}));

import { MailError, mailConfigured, sendMail } from '@/lib/mail';
import { mailText, renderHapmMail } from '@/lib/mail/layout';

const configured: Partial<Settings> = {
  smtpHost: 'smtp.example.org',
  smtpPort: 465,
  smtpSecurity: 'tls',
  smtpUser: 'hapm',
  smtpPass: 'enc:streng-geheim',
  mailFrom: 'Proxy <hapm@example.org>',
};

const mail = {
  to: 'admin@example.org',
  subject: 'Betreff',
  ...renderHapmMail({ subject: 'Betreff', heading: 'Überschrift', body: mailText('Inhalt.') }, { nodeName: 'proxy01', publicUrl: null }),
};

beforeEach(() => {
  sent.length = 0;
  transports.length = 0;
  failWith = null;
  row = {};
});

describe('mailConfigured', () => {
  it('ist falsch, solange Server oder Absender fehlt', async () => {
    expect(await mailConfigured()).toBe(false);
    row = { smtpHost: 'smtp.example.org' };
    expect(await mailConfigured()).toBe(false);
    row = configured;
    expect(await mailConfigured()).toBe(true);
  });
});

describe('sendMail', () => {
  it('wirft mit einem deutschen Satz, wenn nichts eingerichtet ist, und verbindet sich nicht', async () => {
    await expect(sendMail(mail)).rejects.toThrow('Es ist kein SMTP-Konto eingerichtet');
    await expect(sendMail(mail)).rejects.toBeInstanceOf(MailError);
    expect(transports).toHaveLength(0);
  });

  it('verschickt über das gespeicherte Konto, mit Zeitgrenzen', async () => {
    row = configured;
    await sendMail(mail);

    expect(transports[0]).toMatchObject({
      host: 'smtp.example.org',
      port: 465,
      secure: true,
      auth: { user: 'hapm', pass: 'streng-geheim' },
    });
    expect(transports[0].connectionTimeout).toBeGreaterThan(0);
    expect(transports[0].socketTimeout).toBeGreaterThan(0);

    expect(sent[0]).toMatchObject({
      from: '"Proxy" <hapm@example.org>',
      to: 'admin@example.org',
      subject: 'Betreff',
      text: mail.text,
      html: mail.html,
    });
  });

  it('hängt die beiden Logos an, auf die der Rahmen verweist', async () => {
    row = configured;
    await sendMail(mail);
    const attachments = sent[0].attachments as { cid: string; filename: string; content: Buffer }[];
    expect(attachments.map((entry) => entry.cid).sort()).toEqual(['hapm-logo', 'hapm-logo-dark']);
    for (const entry of attachments) expect(entry.content.length).toBeGreaterThan(1000);
  });

  it('hängt nichts an, wenn das HTML kein Logo zeigt', async () => {
    row = configured;
    await sendMail({ ...mail, html: '<p>Nur Text</p>' });
    expect(sent[0].attachments).toEqual([]);
  });

  it('übersetzt die Ablehnung des Servers und nennt seine Antwort, aber nie das Passwort', async () => {
    row = configured;
    failWith = Object.assign(new Error('Invalid login: 535 Authentication failed for streng-geheim'), {
      code: 'EAUTH',
      response: '535 Authentication failed for streng-geheim',
    });
    const error = await sendMail(mail).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MailError);
    expect((error as Error).message).toContain('Der Mailserver hat die Anmeldung abgelehnt.');
    expect((error as Error).message).toContain('535 Authentication failed');
    expect((error as Error).message).not.toContain('streng-geheim');
  });
});
