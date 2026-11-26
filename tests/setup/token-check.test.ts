import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { DnsUnreachableError } from '@/lib/dns/errors';
import { msg } from '@/lib/i18n/translate';

/**
 * Die Vorabprüfung im Assistenten für die Anbieter ohne Token: ein eigener
 * Nameserver (RFC 2136) und Infoblox. Gefragt wird der Anbieter selbst
 * (`probe`), und hier steht nur, was aus seiner Antwort wird: angenommen,
 * abgelehnt (nichts wird abgelegt) oder unbekannt (abgelegt wird trotzdem).
 */

const probes = vi.hoisted(() => ({ rfc2136: vi.fn(), infoblox: vi.fn() }));

vi.mock('@/lib/dns/rfc2136', () => ({ rfc2136: { probe: probes.rfc2136 } }));
vi.mock('@/lib/dns/infoblox', () => ({ infoblox: { probe: probes.infoblox } }));

import { checkDnsToken } from '@/lib/setup/token-check';

const NSUPDATE = {
  NSUPDATE_SERVER: 'ns1.example.org',
  NSUPDATE_SERVER_PORT: '',
  TSIG_NAME: 'hapm-key',
  TSIG_ALGORITHM: '',
  TSIG_SECRET: 'c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LTEyMzQ=',
};

const INFOBLOX = {
  Infoblox_Server: 'infoblox.example.org',
  Infoblox_User: 'hapm',
  Infoblox_Password: 'geh3im!',
  Infoblox_View: '',
  Infoblox_WAPI: '',
  Infoblox_CA: '',
};

beforeEach(() => {
  probes.rfc2136.mockReset();
  probes.infoblox.mockReset();
});

describe('checkDnsToken für RFC 2136', () => {
  it('fragt den Nameserver mit dem Zugang aus dem Formular', async () => {
    probes.rfc2136.mockResolvedValue(undefined);
    expect(await checkDnsToken('dns_nsupdate', NSUPDATE)).toEqual({ result: 'accepted' });
    expect(probes.rfc2136).toHaveBeenCalledWith({
      server: 'ns1.example.org',
      port: 53,
      keyName: 'hapm-key',
      algorithm: 'hmac-sha256',
      secret: NSUPDATE.TSIG_SECRET,
    });
  });

  it('gibt die Absage des Nameservers mit ihrem Grund weiter', async () => {
    probes.rfc2136.mockRejectedValue(
      new ApiError(msg('Der Nameserver {server} hat die Unterschrift abgelehnt. Das Geheimnis des Schlüssels {key} stimmt nicht.', { server: 'ns1', key: 'hapm-key' }), 502)
    );
    const check = await checkDnsToken('dns_nsupdate', NSUPDATE);
    expect(check.result).toBe('rejected');
    expect((check as { message: string }).message).toContain('Das Geheimnis des Schlüssels hapm-key stimmt nicht');
    // Mit Platzhaltern, damit die Route sie in der Sprache der Anfrage wirft.
    expect((check as { detail: { params?: unknown } }).detail.params).toEqual({ server: 'ns1', key: 'hapm-key' });
  });

  it('hält einen Nameserver, der nicht antwortet, nicht für eine Ablehnung', async () => {
    probes.rfc2136.mockRejectedValue(new DnsUnreachableError(msg('Der Nameserver {server} ist über TCP nicht erreichbar.', { server: 'ns1' }), 502));
    const check = await checkDnsToken('dns_nsupdate', NSUPDATE);
    expect(check.result).toBe('unknown');
    expect((check as { message: string }).message).toContain('RFC 2136 war nicht erreichbar');
  });

  it('verschluckt keinen Fehler, der keine Antwort des Anbieters ist', async () => {
    probes.rfc2136.mockRejectedValue(new TypeError('kaputt'));
    await expect(checkDnsToken('dns_nsupdate', NSUPDATE)).rejects.toThrow('kaputt');
  });
});

describe('checkDnsToken für Infoblox', () => {
  it('meldet sich an der Appliance an', async () => {
    probes.infoblox.mockResolvedValue(undefined);
    expect(await checkDnsToken('dns_infoblox', INFOBLOX)).toEqual({ result: 'accepted' });
    expect(probes.infoblox).toHaveBeenCalledWith({
      server: 'infoblox.example.org',
      username: 'hapm',
      password: 'geh3im!',
      view: 'default',
      wapiVersion: '2.2.2',
      ca: null,
    });
  });

  it('liest ein Zertifikat, dem HAPM nicht vertraut, als Ablehnung der Eingabe', async () => {
    probes.infoblox.mockRejectedValue(new ApiError(msg('Dem Zertifikat der Appliance {server} vertraut HAPM nicht.', { server: 'x' }), 502));
    expect((await checkDnsToken('dns_infoblox', INFOBLOX)).result).toBe('rejected');
  });

  it('legt bei einer Appliance, die nicht antwortet, trotzdem ab', async () => {
    probes.infoblox.mockRejectedValue(new DnsUnreachableError(msg('Die Appliance {server} ist nicht erreichbar.', { server: 'x' }), 502));
    expect((await checkDnsToken('dns_infoblox', INFOBLOX)).result).toBe('unknown');
  });
});
