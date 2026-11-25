import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsInput } from '@/lib/settings';

/**
 * Der Schritt „SMTP-Konto" des Assistenten (`/api/setup/mail`): speichert über
 * dieselbe Regel wie „Benachrichtigungen" (`readSmtpInput`, `updateSettings`),
 * überspringt ohne die Einstellungen anzufassen und lässt sich nach der
 * Einrichtung nicht mehr benutzen.
 */

const calls = vi.hoisted(() => ({
  csrf: true,
  setupStatus: 'open' as string | null,
  settings: [] as SettingsInput[],
  state: [] as unknown[],
  audits: [] as { details?: string }[],
}));

vi.mock('@/lib/db', () => ({ getSingleton: vi.fn(), updateDocument: vi.fn() }));

vi.mock('@/lib/session', () => ({
  requireCsrf: async () => {
    if (!calls.csrf) throw new Error('Ungültiger CSRF-Token');
  },
  requireSession: async () => ({ userId: 'u1', email: 'admin@example.org', twoFactorVerified: true }),
}));

vi.mock('@/lib/audit', () => ({
  logAudit: async (entry: { details?: string }) => {
    calls.audits.push(entry);
  },
  getClientIP: () => null,
}));

vi.mock('@/lib/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/settings')>();
  return {
    ...actual,
    getSettings: async () => ({ setupStatus: calls.setupStatus }),
    updateSettings: async (input: SettingsInput) => {
      calls.settings.push(input);
      return {
        smtpHost: input.smtpHost,
        smtpPort: input.smtpPort ?? 587,
        mailFrom: input.mailFrom,
        smtpPass: input.smtpPass ? 'verschlüsselt' : null,
      };
    },
  };
});

vi.mock('@/lib/setup', () => ({ readSetupView: async () => ({ step: 'address' }) }));

vi.mock('@/lib/setup/store', () => ({
  updateSetupState: async (patch: unknown) => {
    calls.state.push(patch);
  },
}));

import { PUT } from '@/app/api/setup/mail/route';

function put(body: unknown): Request {
  return new Request('http://localhost/api/setup/mail', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 't' },
    body: JSON.stringify(body),
  });
}

const ACCOUNT = {
  smtpHost: 'smtp.example.org',
  smtpPort: 465,
  smtpSecurity: 'tls',
  smtpUser: 'hapm',
  smtpPass: 'geheim-123',
  mailFrom: 'HAPM <hapm@example.org>',
};

beforeEach(() => {
  calls.csrf = true;
  calls.setupStatus = 'open';
  calls.settings = [];
  calls.state = [];
  calls.audits = [];
});

describe('/api/setup/mail', () => {
  it('speichert das Konto in den Einstellungen und beantwortet den Schritt', async () => {
    const res = await PUT(put(ACCOUNT));
    expect(res.status).toBe(200);
    expect(calls.settings).toEqual([ACCOUNT]);
    expect(calls.state).toEqual([{ mail: 'set' }]);
    expect(calls.audits).toHaveLength(1);
    // Das Passwort steht weder in der Antwort noch im Protokoll.
    expect(JSON.stringify(await res.json())).not.toContain('geheim-123');
    expect(calls.audits[0].details).not.toContain('geheim-123');
  });

  it('überspringen fasst die Einstellungen nicht an und gilt als erledigt', async () => {
    const res = await PUT(put({ skip: true }));
    expect(res.status).toBe(200);
    expect(calls.settings).toEqual([]);
    expect(calls.state).toEqual([{ mail: 'skipped' }]);
    expect(calls.audits).toHaveLength(1);
  });

  it('nur speichern für die Testmail lässt den Schritt offen', async () => {
    const res = await PUT(put({ ...ACCOUNT, advance: false }));
    expect(res.status).toBe(200);
    expect(calls.settings).toHaveLength(1);
    expect(calls.state).toEqual([]);
  });

  it('ein leeres Passwort behält das gespeicherte', async () => {
    await PUT(put({ ...ACCOUNT, smtpPass: '' }));
    expect(calls.settings[0]).not.toHaveProperty('smtpPass');
  });

  it.each([
    [{ ...ACCOUNT, smtpHost: '  ' }, 'SMTP-Server'],
    [{ ...ACCOUNT, mailFrom: '' }, 'Absender'],
    [{ ...ACCOUNT, smtpPort: '587' }, 'SMTP-Port'],
  ])('lehnt %j ab, ohne zu speichern', async (body, reason) => {
    const res = await PUT(put(body));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(reason);
    expect(calls.settings).toEqual([]);
    expect(calls.state).toEqual([]);
  });

  it('nach der Einrichtung gehört das Konto den Benachrichtigungen', async () => {
    calls.setupStatus = 'done';
    const res = await PUT(put({ skip: true }));
    expect(res.status).toBe(409);
    expect(calls.state).toEqual([]);
  });

  it('tut ohne gültigen CSRF-Token nichts', async () => {
    calls.csrf = false;
    const res = await PUT(put(ACCOUNT));
    expect(res.status).toBe(403);
    expect(calls.settings).toEqual([]);
    expect(calls.state).toEqual([]);
  });
});
