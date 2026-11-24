import { describe, expect, it } from 'vitest';
import {
  PASSKEY_NAME_MAX,
  cleanPasskeyName,
  passkeyAvailability,
  passkeyBrowserError,
  passkeyRelyingParty,
  passkeyStorageLabel,
  suggestPasskeyName,
} from '@/lib/auth/passkey-rules';

describe('Domain und Herkunft eines Passkeys', () => {
  it('kommen aus der Adresse von HAPM, mit dem ganzen Hostnamen', () => {
    expect(passkeyRelyingParty('https://hapm.example.org')).toEqual({
      rpID: 'hapm.example.org',
      origin: 'https://hapm.example.org',
    });
    // Ein abweichender Port gehört zur Herkunft, nicht zur Domain.
    expect(passkeyRelyingParty('https://hapm.example.org:8443')).toEqual({
      rpID: 'hapm.example.org',
      origin: 'https://hapm.example.org:8443',
    });
  });

  it('gibt es nicht ohne Adresse, ohne HTTPS oder mit Unsinn', () => {
    expect(passkeyRelyingParty(null)).toBeNull();
    expect(passkeyRelyingParty('')).toBeNull();
    expect(passkeyRelyingParty('http://hapm.example.org')).toBeNull();
    expect(passkeyRelyingParty('hapm.example.org')).toBeNull();
  });
});

describe('Voraussetzungen für Passkeys', () => {
  it('sind erfüllt mit Adresse und SMTP-Konto', () => {
    expect(passkeyAvailability({ publicUrl: 'https://hapm.example.org', mailConfigured: true })).toEqual({
      available: true,
      missing: [],
    });
  });

  it('nennen, was fehlt', () => {
    expect(passkeyAvailability({ publicUrl: null, mailConfigured: true })).toEqual({
      available: false,
      missing: ['publicUrl'],
    });
    expect(passkeyAvailability({ publicUrl: 'https://hapm.example.org', mailConfigured: false })).toEqual({
      available: false,
      missing: ['mail'],
    });
    expect(passkeyAvailability({ publicUrl: 'http://192.0.2.1:7080', mailConfigured: false })).toEqual({
      available: false,
      missing: ['publicUrl', 'mail'],
    });
  });
});

describe('Namen und Meldungen', () => {
  it('säubert den Namen und lässt ihn nie leer', () => {
    expect(cleanPasskeyName('  Mein\tMac\n ')).toBe('Mein Mac');
    expect(cleanPasskeyName('')).toBe('Passkey');
    expect(cleanPasskeyName(null)).toBe('Passkey');
    expect(cleanPasskeyName('x'.repeat(100))).toHaveLength(PASSKEY_NAME_MAX);
  });

  it('schlägt einen Namen aus der Kennung des Browsers vor', () => {
    expect(suggestPasskeyName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('iPhone');
    expect(suggestPasskeyName('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Windows-PC');
    expect(suggestPasskeyName(undefined)).toBe('Passkey');
  });

  it('beschreibt, wo ein Passkey liegt', () => {
    expect(passkeyStorageLabel({ deviceType: 'multiDevice', backedUp: true })).toBe('Auf Ihren Geräten abgeglichen');
    expect(passkeyStorageLabel({ deviceType: 'singleDevice', backedUp: false })).toBe('Nur auf einem Gerät');
  });

  it('übersetzt die Fehler des Browsers', () => {
    expect(passkeyBrowserError('NotAllowedError', 'login')).toBe('Die Anmeldung wurde abgebrochen.');
    expect(passkeyBrowserError('NotAllowedError', 'register')).toBe('Das Anlegen wurde abgebrochen.');
    expect(passkeyBrowserError('SecurityError', 'register')).toContain('Adresse von HAPM');
    expect(passkeyBrowserError(undefined, 'login')).toBe('Die Anmeldung mit Passkey ist fehlgeschlagen.');
  });
});
