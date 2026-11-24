import { describe, it, expect } from 'vitest';
import { CERT_WARN_DAYS, certificateDue, pemExpiry } from '@/lib/system/certificates';

/** Selbst signiert für diesen Test, gültig bis 21.11.2036 14:39:20 UTC. */
const CERT = `-----BEGIN CERTIFICATE-----
MIIBjjCCATOgAwIBAgIUHP2jjFBEYMA/KL8u8xFzxaQkc6UwCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRdGVzdC5oYXBtLmludmFsaWQwHhcNMjYxMTI0MTQzOTIwWhcN
MzYxMTIxMTQzOTIwWjAcMRowGAYDVQQDDBF0ZXN0LmhhcG0uaW52YWxpZDBZMBMG
ByqGSM49AgEGCCqGSM49AwEHA0IABE7aHbqdiauoS68PbAPgI0f1lbg6Wc3zwwb7
/Zb8dnL0oagpZtYjtPMWOKrdVj3LHuXfWhTTDdRu46oxvbE7vgujUzBRMB0GA1Ud
DgQWBBSMEPrizdNbvm37162ABnn0IAbrFzAfBgNVHSMEGDAWgBSMEPrizdNbvm37
162ABnn0IAbrFzAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0kAMEYCIQC2
bbHP2jCDJ5DNvabP0yjMgcU0AUqppplPSakvFZ/Q0gIhAKF9lkxisz17kefiU8le
3S9Pw1BiylrcaP2TEs1Qp7yi
-----END CERTIFICATE-----
`;
const EXPIRY = '2036-11-21T14:39:20.000Z';
const DAY = 24 * 60 * 60 * 1000;

describe('pemExpiry', () => {
  it('liest das Ablaufdatum eines Zertifikats', () => {
    expect(pemExpiry(CERT)?.toISOString()).toBe(EXPIRY);
  });

  it('nimmt das erste Zertifikat einer Datei, in der noch mehr steht', () => {
    // So schreibt der Deploy-Hook das PEM für HAProxy: Schlüssel, Zertifikat und Kette in einer Datei.
    const bundle = `# Schlüssel und Kette folgen in derselben Datei\n${CERT}-----BEGIN CERTIFICATE-----\nkeinZertifikat\n-----END CERTIFICATE-----\n`;
    expect(pemExpiry(bundle)?.toISOString()).toBe(EXPIRY);
  });

  it('liefert null, wenn kein lesbares Zertifikat da ist', () => {
    expect(pemExpiry('')).toBeNull();
    expect(pemExpiry('kein PEM')).toBeNull();
    expect(pemExpiry('-----BEGIN CERTIFICATE-----\nkaputt\n-----END CERTIFICATE-----')).toBeNull();
  });
});

describe('certificateDue', () => {
  const cert = {
    mainDomain: 'cloud.example.org',
    domains: ['cloud.example.org', 'www.example.org'],
    keyLength: 'ec-256',
    createdAt: '2026-10-21T09:00:00Z',
    renewAt: '2026-12-20T09:00:00Z',
  };
  const now = Date.parse('2026-11-24T12:00:00Z');

  it('rechnet die verbleibenden ganzen Tage', () => {
    const due = certificateDue(cert, new Date(now + 10 * DAY + 3600_000), now);
    expect(due.daysLeft).toBe(10);
    expect(due.daysLeft as number).toBeLessThan(CERT_WARN_DAYS);
    expect(due.expiresAt).toBe(new Date(now + 10 * DAY + 3600_000).toISOString());
    expect(due.renewalOverdue).toBe(false);
  });

  it('zählt ein abgelaufenes Zertifikat negativ', () => {
    expect(certificateDue(cert, new Date(now - 3600_000), now).daysLeft).toBe(-1);
  });

  it('lässt ein unlesbares Ablaufdatum unbekannt', () => {
    const due = certificateDue(cert, null, now);
    expect(due.expiresAt).toBeNull();
    expect(due.daysLeft).toBeNull();
  });

  it('meldet eine Erneuerung als überfällig, wenn ihr Tag mehr als einen Tag zurückliegt', () => {
    expect(certificateDue({ ...cert, renewAt: '2026-11-20T09:00:00Z' }, null, now).renewalOverdue).toBe(true);
    // Am Tag selbst läuft der tägliche Lauf vielleicht erst noch.
    expect(certificateDue({ ...cert, renewAt: '2026-11-24T03:00:00Z' }, null, now).renewalOverdue).toBe(false);
  });

  it('behauptet nichts über eine Erneuerung, deren Zeitpunkt fehlt oder nicht lesbar ist', () => {
    expect(certificateDue({ ...cert, renewAt: null }, null, now).renewalOverdue).toBe(false);
    expect(certificateDue({ ...cert, renewAt: 'bald' }, null, now).renewalOverdue).toBe(false);
  });
});
