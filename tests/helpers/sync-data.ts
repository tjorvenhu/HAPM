import type { SyncData } from '@/lib/sync/data';

/**
 * Ein Datenteil, wie ihn ein Hauptknoten packt: zwei Konten (eines mit zweitem
 * Faktor und Passkey), die Einstellungen, eine Zone, ein API-Key, CrowdSec.
 * Jeder Aufruf liefert eine eigene Kopie, die der Test ändern darf.
 */
export function sampleSyncData(): SyncData {
  return {
    accounts: {
      users: [
        { id: 'user-a', name: 'Ada', email: 'ada@example.org', emailVerified: true, image: null, createdAt: '2026-11-01T08:00:00.000Z' },
        { id: 'user-b', name: 'Ben', email: 'ben@example.org', emailVerified: true, image: null, createdAt: '2026-11-02T08:00:00.000Z' },
      ],
      accounts: [
        { id: 'acc-a', accountId: 'user-a', providerId: 'credential', userId: 'user-a', password: 'salz-a:hash-a', createdAt: '2026-11-01T08:00:00.000Z' },
        { id: 'acc-b', accountId: 'user-b', providerId: 'credential', userId: 'user-b', password: 'salz-b:hash-b', createdAt: '2026-11-02T08:00:00.000Z' },
      ],
      passkeys: [
        {
          id: 'pk-a',
          name: 'Laptop',
          publicKey: 'cHVibGlj',
          userId: 'user-a',
          credentialId: 'cred-a',
          counter: 4,
          deviceType: 'multiDevice',
          backedUp: true,
          transports: 'internal',
          createdAt: '2026-11-03T08:00:00.000Z',
          aaguid: null,
        },
      ],
      twoFactor: [
        { userId: 'user-a', secret: 'JBSWY3DPEHPK3PXP', enabled: true, recoveryCodes: ['h2', 'h1'], recoveryCodesCreatedAt: '2026-11-03T09:00:00.000Z' },
      ],
    },
    settings: {
      acmeEmail: 'acme@example.org',
      publicUrl: 'https://hapm.example.org',
      smtpHost: 'mail.example.org',
      smtpPort: 587,
      smtpSecurity: 'starttls',
      smtpUser: 'hapm',
      smtpPass: 'geheim',
      mailFrom: 'HAPM <hapm@example.org>',
      notifyRecipients: ['ops@example.org'],
      notifyEvents: { sync_failed: true } as SyncData['settings']['notifyEvents'],
      mailLocale: 'de',
      exposure: 'public',
      certificateSource: 'acme',
      acmeDirectory: null,
      acmeHttpReachable: false,
      dnsWait: 60,
    },
    dnsZones: [{ id: 'zone-a', provider: 'cloudflare', name: 'example.org', zoneId: 'cf-1', access: 'token-a' }],
    serviceTokens: [
      {
        id: 'tok-a',
        name: 'deploy',
        tokenHash: 'a'.repeat(64),
        prefix: 'hapm_abcdefg',
        description: null,
        createdBy: 'ada@example.org',
        revokedAt: null,
        scopes: null,
        areas: null,
        allowedIps: null,
      },
    ],
    crowdsec: {
      bans: [{ value: '203.0.113.7', scope: 'ip', reason: 'Gesperrt in HAPM', createdAt: '2026-11-20T10:00:00.000Z', until: '2026-12-20T10:00:00.000Z' }],
      allowlist: [{ value: '198.51.100.0/24', description: 'Büro', expiresAt: null }],
      crs: 'block',
      collections: ['crowdsecurity/http-dos'],
    },
  };
}
