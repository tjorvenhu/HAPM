import { describe, it, expect } from 'vitest';
import {
  challengeArgs,
  challengeChoice,
  needsDnsChallenge,
  planChallenge,
  type ChallengeChoice,
  type ChallengePlan,
} from '@/lib/haproxy/challenge';
import type { CertificateSource, Exposure } from '@/lib/types';
import { germanText, msg, type Message } from '@/lib/i18n/translate';

/**
 * Die Regel, nach der ein Zertifikat über HTTP-01 oder DNS-01 ausgestellt wird,
 * oder gar nicht.
 *
 * Zwei Fehler kosten hier Geld oder Zeit: HTTP-01 auf einer internen
 * Installation scheitert bei Let's Encrypt und zählt gegen das Kontingent, und
 * ein geratener Hook bei mehreren Anbietern setzt die Challenge in der falschen
 * Zone. Dazu kommen zwei Angaben aus den Einstellungen: ein eigener ACME-Server,
 * der HAPM über Port 80 erreicht (HTTP-01 auch intern), und „nur hochladen"
 * (nie beantragen).
 */

const PLAIN = ['app.example.org'];
const WILDCARD = ['example.org', '*.example.org'];

function plan(
  domains: string[],
  exposure: Exposure,
  hooks: string[],
  dnsHook: string | null = null,
  extra: Partial<Pick<ChallengeChoice, 'source' | 'httpReachable'>> = {}
): ChallengePlan {
  return planChallenge(
    domains,
    { exposure, dnsHook, source: 'acme', acmeServer: 'letsencrypt', httpReachable: false, ...extra },
    hooks
  );
}

function text(result: ChallengePlan): string {
  return germanText((result as { message: Message }).message);
}

describe('needsDnsChallenge', () => {
  it('öffentlich und ohne Wildcard: HTTP-01', () => {
    expect(needsDnsChallenge(PLAIN, 'public')).toBe(false);
  });

  it('eine Wildcard braucht DNS-01, egal wo, auch wenn der ACME-Server HAPM erreicht', () => {
    expect(needsDnsChallenge(WILDCARD, 'public')).toBe(true);
    expect(needsDnsChallenge(WILDCARD, 'internal')).toBe(true);
    expect(needsDnsChallenge(WILDCARD, 'internal', true)).toBe(true);
    expect(needsDnsChallenge(WILDCARD, 'public', true)).toBe(true);
  });

  it('intern braucht jede Domain DNS-01, außer der ACME-Server erreicht HAPM über Port 80', () => {
    expect(needsDnsChallenge(PLAIN, 'internal')).toBe(true);
    expect(needsDnsChallenge(PLAIN, 'internal', true)).toBe(false);
  });

  it('öffentlich ändert der Schalter nichts', () => {
    expect(needsDnsChallenge(PLAIN, 'public', true)).toBe(false);
  });
});

describe('planChallenge', () => {
  it('öffentlich ohne Wildcard: HTTP-01, die Hooks spielen keine Rolle', () => {
    for (const hooks of [[], ['dns_cf'], ['dns_cf', 'dns_hetznercloud']]) {
      expect(plan(PLAIN, 'public', hooks)).toEqual({ method: 'http' });
    }
    // Auch ein genannter Hook macht daraus kein DNS-01.
    expect(plan(PLAIN, 'public', ['dns_cf'], 'dns_cf')).toEqual({ method: 'http' });
  });

  describe.each([
    ['öffentlich mit Wildcard', WILDCARD, 'public'],
    ['intern ohne Wildcard', PLAIN, 'internal'],
    ['intern mit Wildcard', WILDCARD, 'internal'],
  ] as const)('%s', (_name, domains, exposure) => {
    it('ohne Hook nicht ausstellbar, mit dem Weg zu den Zugangsdaten', () => {
      const result = plan([...domains], exposure, []);
      expect(result.method).toBe('unavailable');
      expect(text(result)).toContain('Reverse-Proxy, Einstellungen');
      // Und mit dem Weg, der ohne DNS-Anbieter bleibt.
      expect(text(result)).toContain('Reverse-Proxy, Zertifikate');
    });

    it('genau ein Hook gilt, ohne dass ihn jemand nennt', () => {
      expect(plan([...domains], exposure, ['dns_cf'])).toEqual({ method: 'dns', hook: 'dns_cf', wait: null });
    });

    it('ein eigener Nameserver oder Infoblox: acme.sh wartet, statt öffentlich nachzusehen', () => {
      // Die Zone im eigenen Netz sieht kein öffentlicher Resolver: ohne feste
      // Wartezeit liefe der Antrag 20 Minuten lang in den Abbruch.
      expect(plan([...domains], exposure, ['dns_nsupdate'])).toEqual({ method: 'dns', hook: 'dns_nsupdate', wait: 30 });
      expect(plan([...domains], exposure, ['dns_cf', 'dns_infoblox'], 'dns_infoblox')).toEqual({
        method: 'dns',
        hook: 'dns_infoblox',
        wait: 30,
      });
      expect(
        planChallenge(
          [...domains],
          { exposure, dnsHook: null, source: 'acme', acmeServer: 'letsencrypt', httpReachable: false, dnsWait: 120 },
          ['dns_nsupdate']
        )
      ).toEqual({ method: 'dns', hook: 'dns_nsupdate', wait: 120 });
      // Bei einem Anbieter im Internet bleibt es bei der Prüfung von acme.sh.
      expect(
        planChallenge(
          [...domains],
          { exposure, dnsHook: null, source: 'acme', acmeServer: 'letsencrypt', httpReachable: false, dnsWait: 120 },
          ['dns_hetznercloud']
        )
      ).toEqual({ method: 'dns', hook: 'dns_hetznercloud', wait: null });
    });

    it('bei mehreren muss er gewählt sein', () => {
      const result = plan([...domains], exposure, ['dns_cf', 'dns_hetznercloud']);
      expect(result.method).toBe('unavailable');
      expect(text(result)).toContain('dns_cf, dns_hetznercloud');
    });

    it('der gewählte Hook gilt', () => {
      expect(plan([...domains], exposure, ['dns_cf', 'dns_hetznercloud'], 'dns_hetznercloud')).toEqual({
        method: 'dns',
        hook: 'dns_hetznercloud',
        wait: null,
      });
    });

    it('ein nicht eingerichteter Hook wird abgelehnt, auch wenn genau ein anderer da ist', () => {
      // Nicht still auf den einen ausweichen: der Aufrufer hat etwas anderes verlangt.
      const result = plan([...domains], exposure, ['dns_cf'], 'dns_hetznercloud');
      expect(result.method).toBe('unavailable');
      expect(text(result)).toContain('dns_hetznercloud');
    });
  });

  it('sagt bei einer internen Installation ohne Hook, dass sie intern ist, und nennt die anderen Wege', () => {
    const result = plan(PLAIN, 'internal', []);
    expect(text(result)).toContain('intern');
    expect(text(result)).toContain('DNS-Zugangsdaten');
    expect(text(result)).toContain('eigenen ACME-Server');
  });

  describe('ein eigener ACME-Server, der HAPM über Port 80 erreicht', () => {
    it('intern ohne Wildcard: HTTP-01, mit und ohne Hooks', () => {
      for (const hooks of [[], ['dns_cf'], ['dns_cf', 'dns_hetznercloud']]) {
        expect(plan(PLAIN, 'internal', hooks, null, { httpReachable: true })).toEqual({ method: 'http' });
      }
    });

    it('eine Wildcard geht weiter über DNS-01', () => {
      expect(plan(WILDCARD, 'internal', ['dns_cf'], null, { httpReachable: true })).toEqual({
        method: 'dns',
        hook: 'dns_cf',
        wait: null,
      });
      expect(plan(WILDCARD, 'internal', [], null, { httpReachable: true }).method).toBe('unavailable');
    });
  });

  describe('nur hochladen', () => {
    it.each([
      ['öffentlich', PLAIN, 'public', ['dns_cf']],
      ['intern', PLAIN, 'internal', ['dns_cf']],
      ['Wildcard', WILDCARD, 'public', ['dns_cf']],
      ['intern über HTTP', PLAIN, 'internal', []],
    ] as const)('%s: nie beantragen, mit dem Weg zum Hochladen', (_name, domains, exposure, hooks) => {
      const result = plan([...domains], exposure, [...hooks], null, { source: 'upload', httpReachable: true });
      expect(result.method).toBe('unavailable');
      expect(text(result)).toContain('Reverse-Proxy, Zertifikate');
      expect(text(result)).toContain(domains[0]);
    });
  });
});

describe('challengeChoice', () => {
  const settings = (patch: Partial<{
    exposure: Exposure;
    certificateSource: CertificateSource;
    acmeDirectory: string | null;
    acmeHttpReachable: boolean;
  }> = {}) => ({
    exposure: 'internal' as Exposure,
    certificateSource: 'acme' as CertificateSource,
    acmeDirectory: null,
    acmeHttpReachable: false,
    ...patch,
  });

  it('ohne eigenen Server: Let\'s Encrypt, oder was die Umgebung nennt', () => {
    expect(challengeChoice(settings(), null, undefined).acmeServer).toBe('letsencrypt');
    expect(challengeChoice(settings(), null, 'letsencrypt_test').acmeServer).toBe('letsencrypt_test');
  });

  it('der eigene Server steht vor der Umgebung', () => {
    const choice = challengeChoice(settings({ acmeDirectory: 'https://ca.example.org/acme/acme/directory' }), 'dns_cf', 'letsencrypt_test');
    expect(choice.acmeServer).toBe('https://ca.example.org/acme/acme/directory');
    expect(choice.dnsHook).toBe('dns_cf');
  });

  it('HTTP über Port 80 gilt nur mit eigenem Server', () => {
    // Ein Schalter, der von früher noch an steht, macht Let's Encrypt nicht erreichbar.
    expect(challengeChoice(settings({ acmeHttpReachable: true }), null, undefined).httpReachable).toBe(false);
    expect(
      challengeChoice(settings({ acmeHttpReachable: true, acmeDirectory: 'https://ca.example.org/dir' }), null, undefined)
        .httpReachable
    ).toBe(true);
  });

  it('reicht die Wartezeit durch, wenn sie eine ist', () => {
    expect(challengeChoice({ ...settings(), dnsWait: 90 }, null, undefined).dnsWait).toBe(90);
    expect(challengeChoice(settings(), null, undefined).dnsWait).toBeUndefined();
    // Ein Wert außerhalb der Grenzen gilt als nicht gesetzt.
    expect(challengeChoice({ ...settings(), dnsWait: 0 }, null, undefined).dnsWait).toBeUndefined();
  });

  it('reicht Art und Herkunft durch', () => {
    const choice = challengeChoice(settings({ certificateSource: 'upload', exposure: 'public' }), null, undefined);
    expect(choice.source).toBe('upload');
    expect(choice.exposure).toBe('public');
  });
});

describe('challengeArgs', () => {
  it('HTTP-01 läuft über den Port, auf den HAProxy die Challenge weiterleitet', () => {
    expect(challengeArgs({ method: 'http' }, '8888')).toEqual(['--standalone', '--httpport', '8888']);
  });

  it('DNS-01 nennt den Hook', () => {
    expect(challengeArgs({ method: 'dns', hook: 'dns_cf', wait: null }, '8888')).toEqual(['--dns', 'dns_cf']);
  });

  it('DNS-01 mit fester Wartezeit sagt acme.sh, wie lange', () => {
    expect(challengeArgs({ method: 'dns', hook: 'dns_nsupdate', wait: 45 }, '8888')).toEqual([
      '--dns',
      'dns_nsupdate',
      '--dnssleep',
      '45',
    ]);
  });

  it('ohne Weg gibt es kein Kommando', () => {
    expect(() => challengeArgs({ method: 'unavailable', message: msg('fehlt') }, '8888')).toThrow('fehlt');
  });
});
