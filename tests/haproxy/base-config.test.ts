import { describe, it, expect } from 'vitest';
import { STATS_SOCKET, renderBaseConfig } from '@/lib/haproxy/base-config';
import {
  addScope,
  addService,
  applyGlobalSettings,
  parseGlobalSettings,
  parseHaproxyConfig,
  parseScopes,
  parseStatsSocket,
  removeScope,
  removeService,
  type CreateServiceInput,
} from '@/lib/haproxy/config';
import { addStream, parseStreams, removeStream, type CreateStreamInput } from '@/lib/haproxy/streams';
import { parseErrorFiles } from '@/lib/haproxy/error-pages';

/**
 * Die Grundkonfiguration ist die eine Datei, die HAPM selbst als Ganzes schreibt.
 * Alles danach liest und ändert sie über `config.ts`. Sie bringt keine Gruppe
 * mit: die erste legt der Nutzer an. Passt die Form nicht zu dem, was
 * `addScope` erwartet, fällt das nicht beim Anlegen der Datei auf, sondern bei
 * der ersten Gruppe: es gäbe keine Stelle, an die sie gehört.
 */

const BASE = renderBaseConfig({ ipv6: true, errorStatuses: [403, 404, 502, 503, 504] });
const WITH_SCOPE = addScope(BASE, 'KUNDEN');

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
  preset: 'default',
  healthcheck: true,
};

const STREAM: CreateStreamInput = {
  scope: 'KUNDEN',
  id: 'postgres',
  port: 5432,
  servers: [{ name: 'db', target: '10.0.0.9:5432', weight: null }],
  balance: null,
  check: true,
  allowedSources: ['192.0.2.0/24'],
};

describe('renderBaseConfig', () => {
  it('bringt keine Gruppe mit', () => {
    expect(parseScopes(BASE)).toEqual([]);
    expect(BASE).not.toMatch(/^\s*#\s*(BEGIN|END) AUTO /m);
  });

  it('beginnt ohne Ziele und ohne TCP-Weiterleitungen', () => {
    expect(parseHaproxyConfig(BASE)).toEqual([]);
    expect(parseStreams(BASE)).toEqual([]);
  });

  it('nennt den Stats-Socket, über den Zustand und Statistik kommen', () => {
    expect(parseStatsSocket(BASE)).toBe(STATS_SOCKET);
  });

  it('hat den Block der globalen Einstellungen, bearbeitbar und ohne Admin-Adressen', () => {
    const settings = parseGlobalSettings(BASE);
    expect(settings.httpsLines).toEqual([
      'http-response set-header Strict-Transport-Security "max-age=31536000"',
      'http-response set-header X-Content-Type-Options "nosniff"',
      'http-request set-header X-Forwarded-For %[src]',
      'http-request set-header X-Forwarded-Proto https',
      'http-request set-header X-Forwarded-Port 443',
      'http-request set-header X-Forwarded-Host %[req.hdr(host)]',
    ]);
    expect(settings.adminIps).toEqual([]);
    expect(settings.adminEditable).toBe(true);
  });

  it('nimmt Admin-Adressen an und stellt die ACL ins HTTPS-Frontend', () => {
    const settings = parseGlobalSettings(BASE);
    const next = applyGlobalSettings(BASE, { httpsLines: settings.httpsLines ?? [], adminIps: ['192.0.2.10'] });
    expect(parseGlobalSettings(next).adminIps).toEqual(['192.0.2.10']);
    const lines = next.split('\n');
    const acl = lines.findIndex((line) => line.trim().startsWith('acl admin_ips'));
    expect(acl).toBeGreaterThan(lines.findIndex((line) => line.startsWith('frontend public_https')));
    expect(acl).toBeLessThan(lines.findIndex((line) => line.trim().startsWith('default_backend')));
    // Auch mit einer Gruppe steht die ACL vor deren Weichen.
    const scoped = applyGlobalSettings(WITH_SCOPE, { httpsLines: settings.httpsLines ?? [], adminIps: ['192.0.2.10'] }).split('\n');
    expect(scoped.findIndex((line) => line.trim().startsWith('acl admin_ips'))).toBeLessThan(
      scoped.findIndex((line) => line.includes('BEGIN AUTO KUNDEN SERVICES'))
    );
  });

  it('verweist nur auf Fehlerdateien unter /etc/haproxy/errors und beantwortet unbekannte Namen mit 404', () => {
    const refs = parseErrorFiles(BASE);
    expect(refs.every((ref) => ref.path.startsWith('/etc/haproxy/errors/'))).toBe(true);
    expect(refs.some((ref) => ref.code === 404)).toBe(true);
    expect(BASE).toMatch(/backend default_404\s+http-request deny deny_status 404/);
  });

  it('bindet IPv6 nur, wenn die Maschine es hat', () => {
    const v4 = renderBaseConfig({ ipv6: false, errorStatuses: [] });
    expect(v4).not.toContain(':::');
    expect(v4).not.toContain('quic6@');
    expect(BASE).toContain('bind :::443 v6only ssl');
    expect(BASE).toContain('bind quic6@:443 ssl');
  });

  it('trägt die Vorgaben für TLS, HTTP/3 und strict-sni', () => {
    expect(BASE).toContain('ssl-default-bind-options ssl-min-ver TLSv1.2 no-tls-tickets');
    expect(BASE).toContain('ssl-default-bind-ciphersuites TLS_AES_128_GCM_SHA256:');
    expect(BASE).toContain('alpn h2,http/1.1 strict-sni');
    expect(BASE).toContain('bind quic4@:443 ssl crt /etc/haproxy/certs/ alpn h3');
    expect(BASE).toContain('http-response set-header alt-svc "h3=\\":443\\";ma=900"');
    expect(BASE).toContain('chroot /var/lib/haproxy');
    // Im Container läuft HAProxy im Vordergrund.
    expect(BASE).not.toMatch(/^\s*daemon\s*$/m);
  });

  it('nimmt die ACME-Challenge von der Umleitung auf HTTPS aus', () => {
    expect(BASE).toContain('http-request redirect scheme https code 301 unless acme_challenge');
    expect(BASE).toContain('server acme 127.0.0.1:8888');
  });
});

describe('die erste Gruppe in der Grundkonfiguration', () => {
  it('ist vollständig und entfernbar', () => {
    const scopes = parseScopes(WITH_SCOPE);
    expect(scopes.map((s) => s.name)).toEqual(['KUNDEN']);
    expect(scopes[0].complete).toBe(true);
    expect(scopes[0].removable).toBe(true);
  });

  it('stellt den SERVICES-Teil ins HTTPS-Frontend, vor default_backend und dessen Kommentar', () => {
    const lines = WITH_SCOPE.split('\n');
    const frontend = lines.indexOf('frontend public_https');
    const begin = lines.indexOf('    # BEGIN AUTO KUNDEN SERVICES');
    expect(begin).toBeGreaterThan(frontend);
    expect(lines.slice(begin, begin + 5)).toEqual([
      '    # BEGIN AUTO KUNDEN SERVICES',
      '    # END AUTO KUNDEN SERVICES',
      '',
      '    # Default-Error-Page',
      '    default_backend default_404',
    ]);
    expect(lines[begin - 1]).toBe('');
  });

  it('stellt den BACKENDS-Teil hinter das Frontend, vor die Überschrift von acme_challenge', () => {
    const lines = WITH_SCOPE.split('\n');
    const begin = lines.indexOf('# BEGIN AUTO KUNDEN BACKENDS');
    expect(lines.slice(begin - 2, begin + 8)).toEqual([
      '    default_backend default_404',
      '',
      '# BEGIN AUTO KUNDEN BACKENDS',
      '# END AUTO KUNDEN BACKENDS',
      '',
      '# ============================================================',
      '# ACME',
      '# ============================================================',
      '',
      'backend acme_challenge',
    ]);
  });

  it('nimmt ein Ziel auf und gibt es restlos wieder her', () => {
    const withService = addService(WITH_SCOPE, SERVICE);
    const services = parseHaproxyConfig(withService);
    expect(services).toHaveLength(1);
    expect(services[0].scope).toBe('KUNDEN');
    expect(services[0].editable).toBe(true);
    // Das Backend des Ziels steht im BACKENDS-Teil, also vor acme_challenge.
    const lines = withService.split('\n');
    expect(lines.indexOf('backend blog')).toBeGreaterThan(lines.indexOf('# BEGIN AUTO KUNDEN BACKENDS'));
    expect(lines.indexOf('backend blog')).toBeLessThan(lines.indexOf('# END AUTO KUNDEN BACKENDS'));
    expect(removeService(withService, 'blog')).toBe(WITH_SCOPE);
  });

  it('nimmt eine TCP-Weiterleitung auf und gibt sie restlos wieder her', () => {
    const withStream = addStream(WITH_SCOPE, STREAM);
    const streams = parseStreams(withStream);
    expect(streams.map((s) => s.id)).toEqual(['postgres']);
    expect(streams[0].scope).toBe('KUNDEN');
    expect(removeStream(withStream, 'postgres')).toBe(WITH_SCOPE);
  });

  it('lässt sich wieder entfernen, und die Datei ist die Grundkonfiguration', () => {
    expect(removeScope(WITH_SCOPE, 'KUNDEN')).toBe(BASE);
  });

  it('lässt eine zweite Gruppe hinter der ersten zu', () => {
    const two = addScope(WITH_SCOPE, 'INTERN');
    const scopes = parseScopes(two);
    expect(scopes.map((s) => s.name)).toEqual(['KUNDEN', 'INTERN']);
    expect(scopes.every((s) => s.complete && s.removable)).toBe(true);
    expect(removeScope(two, 'INTERN')).toBe(WITH_SCOPE);
  });
});
