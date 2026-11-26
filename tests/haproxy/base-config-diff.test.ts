import { describe, it, expect } from 'vitest';
import { renderBaseConfig, type BaseConfigOptions } from '@/lib/haproxy/base-config';
import {
  applicableDrifts,
  applyBaseConfigDrifts,
  detectIpv6,
  diffBaseConfig,
  directiveKey,
} from '@/lib/haproxy/base-config-diff';
import { addScope, addService, applyGlobalSettings, parseGlobalSettings, type CreateServiceInput } from '@/lib/haproxy/config';

/**
 * Der Abgleich einer bestehenden haproxy.cfg mit der Grundkonfiguration. Die
 * Fälle sind die, die eine ältere Installation wirklich hat: eine neue Vorgabe
 * fehlt (`limited-quic`), ein Wert wurde von Hand geändert, eine Zeile gibt es
 * nur dort. Was verwaltet wird (Marker, globale Einstellungen), bleibt stehen.
 */

const OPTIONS: BaseConfigOptions = { ipv6: true, errorStatuses: [403, 404, 502, 503, 504] };
const BASE = renderBaseConfig(OPTIONS);

/** Eine Zeile entfernen, wie es eine ältere Fassung der Grundkonfiguration
 *  hatte: steht sie als Gruppe für sich, samt Kommentar darüber und der
 *  Leerzeile danach. */
function without(text: string, line: string): string {
  const lines = text.split('\n');
  let index = lines.findIndex((entry) => entry.trim() === line);
  if (index === -1) throw new Error(`Zeile fehlt: ${line}`);
  let count = 1;
  while (lines[index - 1]?.trim().startsWith('#')) {
    index--;
    count++;
  }
  const alone = lines[index - 1]?.trim() === '' && lines[index + count]?.trim() === '';
  lines.splice(index, count + (alone ? 1 : 0));
  return lines.join('\n');
}

function replaced(text: string, from: string, to: string): string {
  if (!text.includes(from)) throw new Error(`Text fehlt: ${from}`);
  return text.replace(from, to);
}

const SERVICE: CreateServiceInput = {
  scope: 'KUNDEN',
  id: 'blog',
  domains: ['blog.example.org'],
  servers: [{ name: 'blog', target: '10.0.0.5:8080', weight: null }],
  redirect: null,
  routes: [],
  balance: null,
  sticky: false,
  lockedDomains: [],
  passwordLock: null,
  responseHeaders: [],
  requestHeaders: [],
  tunnel: false,
  crowdsec: false,
  app: null,
  healthcheck: true,
  backendTls: 'off',
};

describe('diffBaseConfig', () => {
  it('meldet bei einer frischen Grundkonfiguration nichts', () => {
    const diff = diffBaseConfig(BASE, OPTIONS);
    expect(diff.drifts).toEqual([]);
    expect(diff.missingSections).toEqual([]);
  });

  it('meldet auch ohne IPv6 nichts, wenn die Datei ohne IPv6 entstand', () => {
    const options = { ...OPTIONS, ipv6: false };
    const text = renderBaseConfig(options);
    expect(detectIpv6(text)).toBe(false);
    expect(diffBaseConfig(text, options).drifts).toEqual([]);
  });

  it('liest IPv6 an den bind-Zeilen ab', () => {
    expect(detectIpv6(BASE)).toBe(true);
  });

  it('schlägt ein fehlendes limited-quic vor, mit Begründung', () => {
    const diff = diffBaseConfig(without(BASE, 'limited-quic'), OPTIONS);
    expect(diff.drifts).toHaveLength(1);
    expect(diff.drifts[0]).toMatchObject({
      section: 'global',
      kind: 'missing',
      current: null,
      proposed: 'limited-quic',
    });
    expect(diff.drifts[0].hint).toMatch(/QUIC/);
  });

  it('meldet einen anderen Timeout als anderen Wert, nicht als Fehlen und Zusatz', () => {
    const diff = diffBaseConfig(replaced(BASE, 'timeout client 50s', 'timeout client 30s'), OPTIONS);
    expect(diff.drifts).toEqual([
      expect.objectContaining({
        section: 'defaults',
        kind: 'changed',
        current: 'timeout client 30s',
        proposed: 'timeout client 50s',
      }),
    ]);
  });

  it('zeigt eine Zeile, die es nur hier gibt, nur als Hinweis', () => {
    const text = replaced(BASE, '    group haproxy\n', '    group haproxy\n    daemon\n    maxconn 4000\n');
    const diff = diffBaseConfig(text, OPTIONS);
    expect(diff.drifts.map((d) => [d.kind, d.current])).toEqual([
      ['extra', 'daemon'],
      ['extra', 'maxconn 4000'],
    ]);
    expect(diff.drifts[0].hint).toMatch(/Vordergrund/);
    expect(diff.drifts[1].hint).toBeNull();
    expect(applicableDrifts(diff)).toEqual([]);
    expect(() => applyBaseConfigDrifts(text, OPTIONS, [diff.drifts[0].id])).toThrow(/nicht angefasst/);
  });

  it('schlägt das Log in global nie vor, auch wenn es anders lautet', () => {
    const text = replaced(BASE, 'log stdout format raw local0 info', 'log stdout format short daemon');
    expect(diffBaseConfig(text, OPTIONS).drifts).toEqual([]);
  });

  it('lässt eine errorfile-Zeile mit anderer Datei stehen, schlägt fehlende aber vor', () => {
    let text = replaced(BASE, 'errorfile 503 /etc/haproxy/errors/503.http', 'errorfile 503 /etc/haproxy/errors/404.http');
    text = without(text, 'errorfile 502 /etc/haproxy/errors/502.http');
    const diff = diffBaseConfig(text, OPTIONS);
    expect(diff.drifts.map((d) => [d.kind, d.proposed])).toEqual([
      ['missing', 'errorfile 502 /etc/haproxy/errors/502.http'],
    ]);
  });

  it('gleicht die globalen Einstellungen und die Admin-IPs nicht ab', () => {
    const settings = parseGlobalSettings(BASE);
    const text = applyGlobalSettings(BASE, {
      httpsLines: ['http-request set-header X-Forwarded-Proto https', 'option forwardfor'],
      adminIps: ['203.0.113.7'],
    });
    expect(settings.httpsLines?.length).toBeGreaterThan(2);
    expect(diffBaseConfig(text, OPTIONS).drifts).toEqual([]);
  });

  it('gleicht den Zugriffsschutz nicht ab', () => {
    const text = applyGlobalSettings(BASE, {
      httpsLines: parseGlobalSettings(BASE).httpsLines!,
      adminIps: ['203.0.113.7'],
      protection: {
        blockedIps: ['198.51.100.0/24'],
        blockedCountries: ['RU'],
        rateLimit: { requests: 300, period: '10s' },
      },
    });
    expect(diffBaseConfig(text, OPTIONS).drifts).toEqual([]);
  });

  it('übersieht, was zwischen den Markern steht, auch alte vsm_lock-Kennungen', () => {
    let text = addService(addScope(BASE, 'KUNDEN'), SERVICE);
    text = replaced(
      text,
      '    # END AUTO KUNDEN SERVICES',
      '    acl pass_alt req.cook(vsm_lock_alt) -m str abc\n    timeout client 5s\n    # END AUTO KUNDEN SERVICES'
    );
    expect(diffBaseConfig(text, OPTIONS).drifts).toEqual([]);
  });

  it('erkennt umbenannte Frontends an ihrer Rolle', () => {
    let text = replaced(BASE, 'frontend public_http\n', 'frontend http\n');
    text = replaced(text, 'frontend public_https\n', 'frontend https\n');
    text = replaced(text, 'bind :443 ssl', 'bind *:443 ssl');
    expect(diffBaseConfig(text, OPTIONS)).toMatchObject({ drifts: [], missingSections: [] });
  });

  it('meldet einen fehlenden Abschnitt, statt ihn anzulegen', () => {
    const text = BASE.replace(/frontend public_http\n[\s\S]*?(?=# =+\n# HTTPS)/, '');
    const diff = diffBaseConfig(text, OPTIONS);
    expect(diff.missingSections).toEqual(['frontend public_http']);
    expect(diff.drifts).toEqual([]);
  });

  it('erkennt dieselbe Direktive an ihrem Schlüssel', () => {
    expect(directiveKey('    timeout http-request    10s')).toBe('timeout http-request');
    expect(directiveKey('bind 0.0.0.0:80')).toBe('bind :80');
    expect(directiveKey('bind [::]:443 v6only ssl crt /x')).toBe('bind :::443');
    expect(directiveKey('http-response set-header Alt-Svc "x"')).toBe('http-response set-header alt-svc');
  });
});

describe('applyBaseConfigDrifts', () => {
  it('setzt limited-quic an seine Stelle in global', () => {
    const old = without(BASE, 'limited-quic');
    const [drift] = diffBaseConfig(old, OPTIONS).drifts;
    expect(applyBaseConfigDrifts(old, OPTIONS, [drift.id])).toBe(BASE);
  });

  it('setzt limited-quic auch neben ein anderes Log hinter die Log-Zeile', () => {
    const old = replaced(without(BASE, 'limited-quic'), 'log stdout format raw local0 info', 'log stdout format short daemon');
    const [drift] = diffBaseConfig(old, OPTIONS).drifts;
    const next = applyBaseConfigDrifts(old, OPTIONS, [drift.id]);
    expect(next).toContain('global\n    log stdout format short daemon\n\n    limited-quic\n\n    chroot');
  });

  it('ersetzt einen anderen Wert an seiner Stelle', () => {
    const old = replaced(BASE, 'timeout client 50s', 'timeout client 30s');
    const [drift] = diffBaseConfig(old, OPTIONS).drifts;
    expect(applyBaseConfigDrifts(old, OPTIONS, [drift.id])).toBe(BASE);
  });

  it('übernimmt nur, was ausgewählt ist', () => {
    const old = replaced(without(BASE, 'limited-quic'), 'timeout client 50s', 'timeout client 30s');
    const diff = diffBaseConfig(old, OPTIONS);
    const quic = diff.drifts.find((d) => d.proposed === 'limited-quic')!;
    const next = applyBaseConfigDrifts(old, OPTIONS, [quic.id]);
    expect(next).toContain('limited-quic');
    expect(next).toContain('timeout client 30s');
    expect(diffBaseConfig(next, OPTIONS).drifts.map((d) => d.kind)).toEqual(['changed']);
  });

  it('ergibt nach allen Übernahmen genau die Grundkonfiguration', () => {
    let old = without(BASE, 'limited-quic');
    old = without(old, 'stats timeout 30s');
    old = replaced(old, 'timeout client 50s', 'timeout client 30s');
    old = replaced(old, 'timeout queue           30s', 'timeout queue 1m');
    old = replaced(old, 'alpn h2,http/1.1 strict-sni\n', 'alpn h2,http/1.1\n');
    old = without(old, 'errorfile 404 /etc/haproxy/errors/404.http');
    old = old.replace('    bind quic6@:443 ssl crt /etc/haproxy/certs/ alpn h3\n', '');
    old = without(old, 'http-response set-header alt-svc "h3=\\":443\\";ma=900"');

    const diff = diffBaseConfig(old, OPTIONS);
    expect(diff.drifts.every((d) => d.kind !== 'extra')).toBe(true);
    expect(diff.drifts).toHaveLength(8);
    expect(applyBaseConfigDrifts(old, OPTIONS, diff.drifts.map((d) => d.id))).toBe(BASE);
  });

  it('lässt die Marker-Bereiche Zeichen für Zeichen stehen', () => {
    const withService = addService(addScope(BASE, 'KUNDEN'), SERVICE);
    const old = without(replaced(withService, 'timeout client 50s', 'timeout client 30s'), 'limited-quic');
    const diff = diffBaseConfig(old, OPTIONS);
    const next = applyBaseConfigDrifts(old, OPTIONS, diff.drifts.map((d) => d.id));
    expect(next).toBe(withService);

    const block = (text: string) => /# BEGIN AUTO KUNDEN SERVICES[\s\S]*# END AUTO KUNDEN SERVICES/.exec(text)?.[0];
    expect(block(next)).toBe(block(old));
  });

  it('lehnt eine Auswahl ab, die es nicht mehr gibt', () => {
    expect(() => applyBaseConfigDrifts(BASE, OPTIONS, ['global|missing|limited-quic'])).toThrow(/nicht mehr/);
  });
});
