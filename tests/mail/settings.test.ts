import { describe, expect, it, vi } from 'vitest';

// Die Regeln hier sind rein. Die Datenbank bleibt draußen, damit der Test keinen Treiber braucht.
vi.mock('@/lib/db', () => ({ getSingleton: vi.fn(), updateDocument: vi.fn() }));

import {
  normalizePublicUrl,
  normalizeRecipients,
  publicHost,
  publicOrigin,
  settingsPatch,
  settingsView,
  withDefaults,
} from '@/lib/settings';
import { NOTIFICATION_EVENT_TYPES, type Settings } from '@/lib/types';

const encryptPass = (plaintext: string) => `verschlüsselt(${plaintext.length})`;
const current = { notifyEvents: withDefaults({}).notifyEvents };

describe('normalizePublicUrl', () => {
  it('nimmt https mit Domain und speichert sie klein, ohne Schrägstrich am Ende', () => {
    expect(normalizePublicUrl('https://hapm.example.org')).toBe('https://hapm.example.org');
    expect(normalizePublicUrl('  https://HAPM.Example.ORG/  ')).toBe('https://hapm.example.org');
    expect(normalizePublicUrl('HTTPS://hapm.example.org')).toBe('https://hapm.example.org');
  });

  it('behält einen eigenen Port und lässt den üblichen weg', () => {
    expect(normalizePublicUrl('https://hapm.example.org:8443')).toBe('https://hapm.example.org:8443');
    expect(normalizePublicUrl('https://hapm.example.org:443')).toBe('https://hapm.example.org');
  });

  it.each([
    ['http://hapm.example.org', 'https://'],
    ['hapm.example.org', 'https://'],
    ['ftp://hapm.example.org', 'https://'],
    ['https://hapm.example.org/admin', 'ohne Pfad'],
    ['https://hapm.example.org/?a=1', 'ohne Pfad'],
    ['https://hapm.example.org/#oben', 'ohne Pfad'],
    ['https://hapm.example.org?', 'ohne Pfad'],
    ['https://benutzer:geheim@hapm.example.org', 'Zugangsdaten'],
    ['https://192.168.1.10', 'Domainnamen'],
    ['https://[::1]', 'Domainnamen'],
    ['https://', 'gültige Adresse'],
  ])('lehnt %s ab', (input, reason) => {
    expect(() => normalizePublicUrl(input)).toThrow(reason);
  });
});

describe('publicOrigin und publicHost', () => {
  it('sind null, solange nichts eingerichtet ist', () => {
    expect(publicOrigin({ publicUrl: null })).toBeNull();
    expect(publicHost({ publicUrl: null })).toBeNull();
  });

  it('trennen Herkunft und Domain', () => {
    const settings = { publicUrl: 'https://hapm.example.org:8443' };
    expect(publicOrigin(settings)).toBe('https://hapm.example.org:8443');
    expect(publicHost(settings)).toBe('hapm.example.org');
  });

  it('trauen einem gespeicherten Wert nicht blind', () => {
    expect(publicOrigin({ publicUrl: 'http://hapm.example.org' })).toBeNull();
    expect(publicHost({ publicUrl: 'kein-url' })).toBeNull();
  });
});

describe('settingsPatch', () => {
  it('normalisiert die Adresse und nimmt leer als entfernt', () => {
    expect(settingsPatch({ publicUrl: 'https://HAPM.example.org/' }, current, encryptPass).publicUrl).toBe(
      'https://hapm.example.org'
    );
    expect(settingsPatch({ publicUrl: '  ' }, current, encryptPass).publicUrl).toBeNull();
    expect(settingsPatch({ publicUrl: null }, current, encryptPass).publicUrl).toBeNull();
    expect(() => settingsPatch({ publicUrl: 'http://hapm.example.org' }, current, encryptPass)).toThrow();
  });

  it('verschlüsselt ein neues Passwort und speichert es nie im Klartext', () => {
    const patch = settingsPatch({ smtpPass: 'streng-geheim' }, current, encryptPass);
    expect(patch.smtpPass).toBe('verschlüsselt(13)');
    expect(JSON.stringify(patch)).not.toContain('streng-geheim');
  });

  it('lässt das Passwort stehen, wenn es leer oder ausgelassen ist, und löscht es nur auf null', () => {
    expect('smtpPass' in settingsPatch({ smtpHost: 'smtp.example.org' }, current, encryptPass)).toBe(false);
    expect('smtpPass' in settingsPatch({ smtpPass: '' }, current, encryptPass)).toBe(false);
    expect(settingsPatch({ smtpPass: null }, current, encryptPass).smtpPass).toBeNull();
  });

  it('prüft Server, Port, Verschlüsselung und Absender', () => {
    expect(settingsPatch({ smtpHost: ' SMTP.Example.org ' }, current, encryptPass).smtpHost).toBe('smtp.example.org');
    expect(() => settingsPatch({ smtpHost: 'smtp example' }, current, encryptPass)).toThrow('SMTP-Server');
    expect(() => settingsPatch({ smtpPort: 0 }, current, encryptPass)).toThrow('Port');
    expect(() => settingsPatch({ smtpPort: 70000 }, current, encryptPass)).toThrow('Port');
    expect(() => settingsPatch({ smtpPort: 58.7 }, current, encryptPass)).toThrow('Port');
    expect(() => settingsPatch({ smtpSecurity: 'ssl' as never }, current, encryptPass)).toThrow('Verschlüsselung');
    expect(settingsPatch({ mailFrom: 'HAPM <hapm@example.org>' }, current, encryptPass).mailFrom).toBe(
      'HAPM <hapm@example.org>'
    );
    expect(() => settingsPatch({ mailFrom: 'kein absender' }, current, encryptPass)).toThrow('Absender');
  });

  it('ändert nur die genannten Schalter und kennt keine fremden Ereignisse', () => {
    const patch = settingsPatch({ notifyEvents: { update_completed: false } }, current, encryptPass);
    expect(patch.notifyEvents?.update_completed).toBe(false);
    expect(patch.notifyEvents?.backend_down).toBe(true);
    expect(() => settingsPatch({ notifyEvents: { login_new_device: true } as never }, current, encryptPass)).toThrow(
      'gibt es nicht'
    );
    expect(() => settingsPatch({ notifyEvents: { backend_down: 'ja' } as never }, current, encryptPass)).toThrow();
  });
});

describe('normalizeRecipients', () => {
  it('entfernt Leerraum, Leeres und Doppelte', () => {
    expect(normalizeRecipients([' a@example.org ', '', 'A@example.org', 'b@example.org'])).toEqual([
      'a@example.org',
      'b@example.org',
    ]);
  });

  it('lehnt ab, was keine Adresse ist', () => {
    expect(() => normalizeRecipients(['a@example.org', 'kaputt'])).toThrow('kaputt');
    expect(() => normalizeRecipients([42])).toThrow();
  });
});

describe('withDefaults', () => {
  it('ergänzt eine alte Zeile um alles, was später dazukam', () => {
    const settings = withDefaults({ acmeEmail: 'a@example.org', autoUpdateTime: '05:00' });
    expect(settings.acmeEmail).toBe('a@example.org');
    expect(settings.autoUpdateTime).toBe('05:00');
    expect(settings.smtpPort).toBe(587);
    expect(settings.smtpSecurity).toBe('starttls');
    expect(settings.notifyRecipients).toEqual([]);
    for (const type of NOTIFICATION_EVENT_TYPES) expect(settings.notifyEvents[type]).toBe(true);
  });

  it('schaltet ein Ereignis ein, das in den gespeicherten Schaltern fehlt', () => {
    const settings = withDefaults({ notifyEvents: { backend_down: false } as Settings['notifyEvents'] });
    expect(settings.notifyEvents.backend_down).toBe(false);
    expect(settings.notifyEvents.backup_failed).toBe(true);
  });
});

describe('settingsView', () => {
  it('nennt vom Passwort nur, ob es gesetzt ist', () => {
    const settings = {
      ...withDefaults({ smtpHost: 'smtp.example.org', smtpPass: 'aa:bb:cc' }),
      $id: 'main',
      $createdAt: '',
      $updatedAt: '',
    } as Settings;
    const view = settingsView(settings);
    expect(view.smtpPassSet).toBe(true);
    expect('smtpPass' in view).toBe(false);
    expect(JSON.stringify(view)).not.toContain('aa:bb:cc');
    expect(settingsView({ ...settings, smtpPass: null }).smtpPassSet).toBe(false);
  });
});
