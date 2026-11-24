import { describe, it, expect } from 'vitest';
import {
  challengeArgs,
  needsDnsChallenge,
  planChallenge,
  type ChallengePlan,
} from '@/lib/haproxy/challenge';
import type { Exposure } from '@/lib/types';

/**
 * Die Regel, nach der ein Zertifikat über HTTP-01 oder DNS-01 ausgestellt wird.
 *
 * Zwei Fehler kosten hier Geld oder Zeit: HTTP-01 auf einer internen
 * Installation scheitert bei Let's Encrypt und zählt gegen das Kontingent, und
 * ein geratener Hook bei mehreren Anbietern setzt die Challenge in der falschen
 * Zone.
 */

const PLAIN = ['app.example.org'];
const WILDCARD = ['example.org', '*.example.org'];

function plan(domains: string[], exposure: Exposure, hooks: string[], dnsHook: string | null = null): ChallengePlan {
  return planChallenge(domains, { exposure, dnsHook }, hooks);
}

describe('needsDnsChallenge', () => {
  it('öffentlich und ohne Wildcard: HTTP-01', () => {
    expect(needsDnsChallenge(PLAIN, 'public')).toBe(false);
  });

  it('eine Wildcard braucht DNS-01, egal wo', () => {
    expect(needsDnsChallenge(WILDCARD, 'public')).toBe(true);
    expect(needsDnsChallenge(WILDCARD, 'internal')).toBe(true);
  });

  it('intern braucht jede Domain DNS-01', () => {
    expect(needsDnsChallenge(PLAIN, 'internal')).toBe(true);
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
      expect((result as { message: string }).message).toContain('Reverse-Proxy, Einstellungen');
    });

    it('genau ein Hook gilt, ohne dass ihn jemand nennt', () => {
      expect(plan([...domains], exposure, ['dns_cf'])).toEqual({ method: 'dns', hook: 'dns_cf' });
    });

    it('bei mehreren muss er gewählt sein', () => {
      const result = plan([...domains], exposure, ['dns_cf', 'dns_hetznercloud']);
      expect(result.method).toBe('unavailable');
      expect((result as { message: string }).message).toContain('dns_cf, dns_hetznercloud');
    });

    it('der gewählte Hook gilt', () => {
      expect(plan([...domains], exposure, ['dns_cf', 'dns_hetznercloud'], 'dns_hetznercloud')).toEqual({
        method: 'dns',
        hook: 'dns_hetznercloud',
      });
    });

    it('ein nicht eingerichteter Hook wird abgelehnt, auch wenn genau ein anderer da ist', () => {
      // Nicht still auf den einen ausweichen: der Aufrufer hat etwas anderes verlangt.
      const result = plan([...domains], exposure, ['dns_cf'], 'dns_hetznercloud');
      expect(result.method).toBe('unavailable');
      expect((result as { message: string }).message).toContain('dns_hetznercloud');
    });
  });

  it('sagt bei einer internen Installation ohne Hook, dass sie intern ist', () => {
    const result = plan(PLAIN, 'internal', []);
    expect((result as { message: string }).message).toContain('intern');
    expect((result as { message: string }).message).toContain('DNS-Zugangsdaten');
  });
});

describe('challengeArgs', () => {
  it('HTTP-01 läuft über den Port, auf den HAProxy die Challenge weiterleitet', () => {
    expect(challengeArgs({ method: 'http' }, '8888')).toEqual(['--standalone', '--httpport', '8888']);
  });

  it('DNS-01 nennt den Hook', () => {
    expect(challengeArgs({ method: 'dns', hook: 'dns_cf' }, '8888')).toEqual(['--dns', 'dns_cf']);
  });

  it('ohne Weg gibt es kein Kommando', () => {
    expect(() => challengeArgs({ method: 'unavailable', message: 'fehlt' }, '8888')).toThrow('fehlt');
  });
});
