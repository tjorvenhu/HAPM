import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@/lib/types';

/**
 * `notify` von Ende zu Ende, ohne Netz und ohne Datenbank: die Fassade liegt im
 * Speicher (`fake-db.ts`), der Versand sammelt nur ein.
 */

vi.mock('@/lib/db', async () => await import('./fake-db'));

vi.mock('@/lib/crypto', () => ({
  encrypt: (plaintext: string) => `enc:${plaintext}`,
  decrypt: (ciphertext: string) => ciphertext.replace(/^enc:/, ''),
}));

const outbox: { to: string; subject: string; html: string; text: string }[] = [];
let sendFailure: ((to: string) => Error | null) | null = null;

vi.mock('@/lib/mail', async () => {
  const { MailError, isMailConfigured } = await import('@/lib/mail/config');
  const { getSettings } = await import('@/lib/settings');
  return {
    MailError,
    mailConfigured: async () => isMailConfigured(await getSettings()),
    sendMail: async (mail: { to: string; subject: string; html: string; text: string }) => {
      const failure = sendFailure?.(mail.to) ?? null;
      if (failure) throw failure;
      outbox.push(mail);
    },
  };
});

import { breakFakeDb, createDocument, resetFakeDb, rowsOf } from './fake-db';
import { MailError } from '@/lib/mail/config';
import { notificationStatus, notify, sendTestMail } from '@/lib/notifications';
import { pruneStates, resolveState } from '@/lib/notifications/state';
import type { NotificationEvent } from '@/lib/notifications/events';

const HOUR = 60 * 60 * 1000;
const START = new Date('2026-11-24T12:00:00.000Z');

const READY: Partial<Settings> = {
  publicUrl: 'https://hapm.example.org',
  smtpHost: 'smtp.example.org',
  smtpPort: 587,
  smtpSecurity: 'starttls',
  smtpUser: 'hapm',
  smtpPass: 'enc:streng-geheim',
  mailFrom: 'hapm@example.org',
  notifyRecipients: ['a@example.org', 'b@example.org'],
};

async function install(settings: Partial<Settings>): Promise<void> {
  await createDocument('settings', settings as Record<string, unknown>, 'main');
}

const down = (id: string): NotificationEvent => ({
  type: 'backend_down',
  kind: 'service',
  id,
  addresses: [`${id}.example.org`],
  targets: ['10.0.0.5:8080'],
  since: START.toISOString(),
});

let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  resetFakeDb();
  outbox.length = 0;
  sendFailure = null;
  delete (globalThis as { __hapmNotify?: unknown }).__hapmNotify;
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  errors.mockRestore();
});

describe('notify: ob überhaupt etwas rausgeht', () => {
  it('verschickt an jeden Empfänger eine eigene Mail', async () => {
    await install(READY);
    expect(await notify(down('shop'))).toBe('sent');
    expect(outbox.map((mail) => mail.to)).toEqual(['a@example.org', 'b@example.org']);
    expect(outbox[0].subject).toBe('shop.example.org: kein Ziel antwortet');
    expect(outbox[0].text).toContain('https://hapm.example.org/reverse-proxy');
  });

  it('schweigt, wenn das Ereignis ausgeschaltet ist, und lässt die anderen durch', async () => {
    await install({ ...READY, notifyEvents: { backend_down: false } as Settings['notifyEvents'] });
    expect(await notify(down('shop'))).toBe('disabled');
    expect(outbox).toHaveLength(0);
    expect(await notify({ type: 'backup_failed', detail: 'Platte voll' })).toBe('sent');
  });

  it('schweigt ohne Empfänger', async () => {
    await install({ ...READY, notifyRecipients: [] });
    expect(await notify(down('shop'))).toBe('no_recipients');
    expect(outbox).toHaveLength(0);
  });

  it('schweigt ohne SMTP-Konto', async () => {
    await install({ ...READY, smtpHost: null });
    expect(await notify(down('shop'))).toBe('not_configured');
    await install({ ...READY, mailFrom: null });
    expect(await notify(down('shop'))).toBe('not_configured');
    expect(outbox).toHaveLength(0);
  });

  it('schickt nie ein Geheimnis mit', async () => {
    await install(READY);
    await notify({ type: 'update_failed', component: 'haproxy', fromVersion: '3.4.8', error: 'kaputt', triggeredBy: null });
    for (const mail of outbox) {
      expect(`${mail.subject}${mail.html}${mail.text}`).not.toContain('streng-geheim');
      expect(`${mail.html}${mail.text}`).not.toContain('smtp.example.org');
    }
  });
});

describe('notify: Dämpfung', () => {
  it('meldet dieselbe Sache am selben Tag nur einmal', async () => {
    await install(READY);
    expect(await notify(down('shop'))).toBe('sent');
    vi.setSystemTime(new Date(START.getTime() + 2 * 60 * 1000));
    expect(await notify(down('shop'))).toBe('dampened');
    vi.setSystemTime(new Date(START.getTime() + 20 * HOUR));
    expect(await notify(down('shop'))).toBe('dampened');
    expect(outbox).toHaveLength(2);
  });

  it('meldet sie am nächsten Tag wieder', async () => {
    await install(READY);
    await notify(down('shop'));
    vi.setSystemTime(new Date(START.getTime() + 24 * HOUR));
    expect(await notify(down('shop'))).toBe('sent');
    expect(outbox).toHaveLength(4);
  });

  it('dämpft je Sache, nicht je Ereignis', async () => {
    await install(READY);
    expect(await notify(down('shop'))).toBe('sent');
    expect(await notify(down('blog'))).toBe('sent');
  });

  it('gilt auch nach einem Neustart, weil der Stand in der Datenbank liegt', async () => {
    await install(READY);
    await notify(down('shop'));
    delete (globalThis as { __hapmNotify?: unknown }).__hapmNotify;
    vi.setSystemTime(new Date(START.getTime() + HOUR));
    expect(await notify(down('shop'))).toBe('dampened');
  });

  it('macht aus zwei gleichzeitigen Meldungen derselben Sache eine Mail', async () => {
    await install({ ...READY, notifyRecipients: ['a@example.org'] });
    const outcomes = await Promise.all([notify(down('shop')), notify(down('shop'))]);
    expect(outcomes.sort()).toEqual(['dampened', 'sent']);
    expect(outbox).toHaveLength(1);
  });

  it('meldet eine neue Fassung einmal, auch Wochen später nicht wieder, die nächste aber schon', async () => {
    await install({ ...READY, notifyRecipients: ['a@example.org'] });
    const available = (digest: string): NotificationEvent => ({
      type: 'update_available',
      component: 'haproxy',
      currentVersion: '3.4.8',
      latestVersion: '3.4.9',
      latestDigest: digest,
    });
    expect(await notify(available('sha256:aaa'))).toBe('sent');
    vi.setSystemTime(new Date(START.getTime() + 30 * 24 * HOUR));
    expect(await notify(available('sha256:aaa'))).toBe('dampened');
    expect(await notify(available('sha256:bbb'))).toBe('sent');
  });

  it('räumt auf, was lange zurückliegt, und lässt den letzten Versand stehen', async () => {
    await install(READY);
    await notify(down('shop'));
    expect(await pruneStates(START.getTime() + 30 * 24 * HOUR)).toBe(0);
    expect(await pruneStates(START.getTime() + 200 * 24 * HOUR)).toBe(1);
    expect((await notificationStatus()).lastDelivery?.kind).toBe('backend_down');
  });
});

describe('notify: Entwarnung', () => {
  it('gibt es nur für einen Ausfall, der gemeldet wurde, und nur einmal', async () => {
    await install(READY);
    expect(await resolveState('backend_down', 'service:shop', START.toISOString())).toBeNull();

    await notify(down('shop'));
    const announced = await resolveState('backend_down', 'service:shop', new Date(START.getTime() + HOUR).toISOString());
    expect(announced?.lastSentAt).toBe(START.toISOString());
    expect(await resolveState('backend_down', 'service:shop', new Date(START.getTime() + 2 * HOUR).toISOString())).toBeNull();
  });

  it('gibt es nach einem gedämpften zweiten Ausfall nicht noch einmal', async () => {
    await install(READY);
    await notify(down('shop'));
    await resolveState('backend_down', 'service:shop', new Date(START.getTime() + HOUR).toISOString());

    vi.setSystemTime(new Date(START.getTime() + 2 * HOUR));
    expect(await notify(down('shop'))).toBe('dampened');
    expect(await resolveState('backend_down', 'service:shop', new Date(START.getTime() + 3 * HOUR).toISOString())).toBeNull();
  });
});

describe('notify: wenn es schiefgeht', () => {
  it('wirft nicht, wenn der Mailserver ablehnt, und hält den Fehler für die Oberfläche fest', async () => {
    await install(READY);
    sendFailure = () => new MailError('Der Mailserver hat die Anmeldung abgelehnt. Meldung: 535', 'unavailable');

    expect(await notify(down('shop'))).toBe('failed');
    expect(errors).toHaveBeenCalled();

    const status = await notificationStatus();
    expect(status.lastDelivery).toMatchObject({ ok: false, kind: 'backend_down', delivered: 0, recipients: 2 });
    expect(status.lastDelivery?.error).toContain('Anmeldung abgelehnt');
  });

  it('versucht es nach einem Fehlschlag nicht alle zwei Minuten, aber bald wieder', async () => {
    await install(READY);
    sendFailure = () => new MailError('Keine Verbindung.', 'unavailable');
    expect(await notify(down('shop'))).toBe('failed');

    sendFailure = null;
    vi.setSystemTime(new Date(START.getTime() + 2 * 60 * 1000));
    expect(await notify(down('shop'))).toBe('dampened');
    vi.setSystemTime(new Date(START.getTime() + 16 * 60 * 1000));
    expect(await notify(down('shop'))).toBe('sent');
  });

  it('hört beim ersten Empfänger auf, wenn es am Konto liegt', async () => {
    await install(READY);
    const tried: string[] = [];
    sendFailure = (to) => {
      tried.push(to);
      return new MailError('Keine Verbindung.', 'unavailable');
    };
    await notify(down('shop'));
    expect(tried).toEqual(['a@example.org']);
  });

  it('schickt an die übrigen, wenn der Server nur eine Adresse ablehnt', async () => {
    await install(READY);
    sendFailure = (to) => (to === 'a@example.org' ? new MailError('550 Unbekannter Empfänger', 'rejected') : null);

    expect(await notify(down('shop'))).toBe('sent');
    expect(outbox.map((mail) => mail.to)).toEqual(['b@example.org']);
    expect((await notificationStatus()).lastDelivery).toMatchObject({ ok: false, delivered: 1, recipients: 2 });
  });

  it('wirft auch dann nicht, wenn die Datenbank weg ist', async () => {
    await install(READY);
    breakFakeDb();
    await expect(notify(down('shop'))).resolves.toBe('failed');
    expect(outbox).toHaveLength(0);
  });

  it('verschickt nicht doppelt, wenn sich der Versand nicht festhalten lässt', async () => {
    await install({ ...READY, notifyRecipients: ['a@example.org'] });
    sendFailure = () => {
      breakFakeDb();
      return null;
    };
    expect(await notify(down('shop'))).toBe('sent');

    breakFakeDb(false);
    sendFailure = null;
    vi.setSystemTime(new Date(START.getTime() + 2 * 60 * 1000));
    expect(await notify(down('shop'))).toBe('dampened');
    expect(outbox).toHaveLength(1);
  });
});

describe('sendTestMail', () => {
  it('meldet den Erfolg und hält ihn als letzten Versand fest', async () => {
    await install(READY);
    expect(await sendTestMail('ich@example.org')).toEqual({ sent: true, to: 'ich@example.org', error: null });
    expect(outbox[0]).toMatchObject({ to: 'ich@example.org', subject: 'Testmail von HAPM' });
    expect((await notificationStatus()).lastDelivery).toMatchObject({ ok: true, kind: 'test', delivered: 1 });
  });

  it('gibt die Meldung des Servers zurück, statt zu werfen', async () => {
    await install(READY);
    sendFailure = () => new MailError('Der Mailserver hat die Anmeldung abgelehnt. Meldung: 535 5.7.8', 'unavailable');
    const result = await sendTestMail('ich@example.org');
    expect(result.sent).toBe(false);
    expect(result.error).toContain('535 5.7.8');
  });

  it('wird von der Dämpfung nicht berührt und berührt sie nicht', async () => {
    await install(READY);
    await sendTestMail('ich@example.org');
    await sendTestMail('ich@example.org');
    expect(outbox).toHaveLength(2);
    expect(rowsOf('notification_state').filter((row) => 'lastSentAt' in row)).toHaveLength(0);
  });
});

describe('notificationStatus', () => {
  it('sagt, was fehlt, und nennt ohne Versand keinen', async () => {
    await install({ ...READY, smtpHost: null, notifyRecipients: [] });
    expect(await notificationStatus()).toEqual({ mailConfigured: false, recipients: 0, lastDelivery: null });
  });
});
