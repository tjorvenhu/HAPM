import { describe, it, expect } from 'vitest';
import { parseReference, parseChallenge, versionOf } from '@/lib/docker/registry';

const HUB = 'registry-1.docker.io';
const DIGEST = 'sha256:5f1c2b0f6a1d4d0c9c2a7f3e8b6d4c2a1f0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c';

describe('parseReference', () => {
  it('liest ein offizielles Abbild mit Tag als Docker Hub und library/', () => {
    expect(parseReference('haproxy:lts')).toEqual({ registry: HUB, repository: 'library/haproxy', tag: 'lts' });
  });

  it('nimmt ohne Tag latest', () => {
    expect(parseReference('haproxy')).toEqual({ registry: HUB, repository: 'library/haproxy', tag: 'latest' });
  });

  it('erkennt eine fremde Registry am Punkt im ersten Teil', () => {
    expect(parseReference('ghcr.io/tjorvenhu/hapm:latest')).toEqual({
      registry: 'ghcr.io',
      repository: 'tjorvenhu/hapm',
      tag: 'latest',
    });
  });

  it('hält den Port einer Registry nicht für einen Tag', () => {
    expect(parseReference('localhost:5000/x/y:1')).toEqual({
      registry: 'localhost:5000',
      repository: 'x/y',
      tag: '1',
    });
    expect(parseReference('localhost:5000/x/y')).toEqual({
      registry: 'localhost:5000',
      repository: 'x/y',
      tag: 'latest',
    });
  });

  it('hält einen Benutzer auf Docker Hub nicht für eine Registry', () => {
    expect(parseReference('haproxytech/haproxy-alpine:3.2')).toEqual({
      registry: HUB,
      repository: 'haproxytech/haproxy-alpine',
      tag: '3.2',
    });
  });

  it('führt die Schreibweisen von Docker Hub auf einen Host zurück', () => {
    expect(parseReference('docker.io/haproxy:lts')).toEqual({ registry: HUB, repository: 'library/haproxy', tag: 'lts' });
    expect(parseReference('index.docker.io/library/haproxy')).toEqual({
      registry: HUB,
      repository: 'library/haproxy',
      tag: 'latest',
    });
  });

  it('lässt einen Digest weg und behält den Tag davor', () => {
    expect(parseReference(`haproxy:lts@${DIGEST}`)).toEqual({ registry: HUB, repository: 'library/haproxy', tag: 'lts' });
    expect(parseReference(`ghcr.io/tjorvenhu/hapm@${DIGEST}`)).toEqual({
      registry: 'ghcr.io',
      repository: 'tjorvenhu/hapm',
      tag: 'latest',
    });
    expect(parseReference(`localhost:5000/x/y@${DIGEST}`)).toEqual({
      registry: 'localhost:5000',
      repository: 'x/y',
      tag: 'latest',
    });
  });

  it('verträgt Leerraum am Rand', () => {
    expect(parseReference('  haproxy:lts\n')).toEqual({ registry: HUB, repository: 'library/haproxy', tag: 'lts' });
  });
});

describe('parseChallenge', () => {
  it('zerlegt die Aufforderung von Docker Hub', () => {
    expect(
      parseChallenge(
        'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/haproxy:pull"'
      )
    ).toEqual({
      realm: 'https://auth.docker.io/token',
      service: 'registry.docker.io',
      scope: 'repository:library/haproxy:pull',
    });
  });

  it('nimmt das Schema in jeder Schreibweise und Leerraum zwischen den Teilen', () => {
    expect(parseChallenge('bearer realm="https://ghcr.io/token", service="ghcr.io"')).toEqual({
      realm: 'https://ghcr.io/token',
      service: 'ghcr.io',
    });
  });

  it('liefert null ohne Kopfzeile, bei einem anderen Schema und ohne realm', () => {
    expect(parseChallenge(null)).toBeNull();
    expect(parseChallenge('')).toBeNull();
    expect(parseChallenge('Basic realm="Registry"')).toBeNull();
    expect(parseChallenge('Bearer service="registry.docker.io"')).toBeNull();
  });
});

describe('versionOf', () => {
  it('liest die Version von HAProxy aus der Umgebung des Abbilds', () => {
    expect(versionOf(['PATH=/usr/local/bin', 'HAPROXY_VERSION=3.4.8', 'HAPROXY_URL=https://example.invalid'], null)).toBe(
      '3.4.8'
    );
  });

  it('nimmt sonst das Label, wie HAPM es trägt', () => {
    expect(versionOf(['NODE_ENV=production'], { 'org.opencontainers.image.version': '0.1.0' })).toBe('0.1.0');
    expect(versionOf(null, { 'org.opencontainers.image.version': '0.1.0' })).toBe('0.1.0');
  });

  it('zieht die Umgebung dem Label vor', () => {
    expect(versionOf(['HAPROXY_VERSION=3.4.9'], { 'org.opencontainers.image.version': '1.0.0' })).toBe('3.4.9');
  });

  it('verwechselt keine Variable, die nur so anfängt', () => {
    expect(versionOf(['HAPROXY_VERSION_SHA256=abc'], null)).toBeNull();
  });

  it('fällt bei leerer Variable auf das Label zurück', () => {
    expect(versionOf(['HAPROXY_VERSION='], { 'org.opencontainers.image.version': '0.1.0' })).toBe('0.1.0');
  });

  it('liefert null, wenn nichts da ist', () => {
    expect(versionOf(undefined, undefined)).toBeNull();
    expect(versionOf([], {})).toBeNull();
    expect(versionOf([], { 'org.opencontainers.image.version': '' })).toBeNull();
  });
});
