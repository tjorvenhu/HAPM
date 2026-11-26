import { describe, it, expect } from 'vitest';
import { renderBaseConfig } from '@/lib/haproxy/base-config';
import {
  APP_LINE_PREFIX,
  addScope,
  addService,
  parseHaproxyConfig,
  readServiceInput,
  removeService,
  replaceService,
  toCreateInput,
  validateCreateInput,
  type CreateServiceInput,
} from '@/lib/haproxy/config';
import { appUsage } from '@/lib/crowdsec/apps';

/**
 * Die Anwendung hinter einem Ziel steht als Kommentar im Backend
 * (`# hapm-app: <id>`). HAProxy liest ihn nicht, HAPM richtet danach die
 * Ausnahmen von CrowdSec für dieses Ziel ein.
 */

const BASE = addScope(renderBaseConfig({ ipv6: false, errorStatuses: [403, 404] }), 'WEB');

const SERVICE: CreateServiceInput = {
  scope: 'WEB',
  id: 'cloud',
  domains: ['cloud.example.org', '*.files.example.org'],
  servers: [{ name: 'cloud', target: '10.0.0.5:8080', weight: null }],
  redirect: null,
  routes: [{ name: 'push', paths: ['/push'], servers: [{ name: 'push', target: '10.0.0.5:7867' }], check: false, backendTls: 'off' }],
  balance: null,
  sticky: false,
  lockedDomains: [],
  passwordLock: null,
  responseHeaders: [],
  requestHeaders: [],
  tunnel: false,
  crowdsec: false,
  app: 'nextcloud',
  healthcheck: false,
  backendTls: 'off',
};

const find = (text: string, id: string) => parseHaproxyConfig(text).find((s) => s.id === id)!;

describe('Anwendung am Ziel', () => {
  it('steht direkt unter der backend-Zeile und kommt beim Lesen zurück', () => {
    const text = addService(BASE, SERVICE);
    expect(text).toContain(`backend cloud\n    ${APP_LINE_PREFIX} nextcloud\n`);
    const service = find(text, 'cloud');
    expect(service.app).toBe('nextcloud');
    expect(service.editable).toBe(true);
    expect(service.extras).toEqual([]);
    expect(toCreateInput(service)).toEqual(SERVICE);
  });

  it('lässt sich ändern und entfernen, ohne Reste', () => {
    const text = addService(BASE, SERVICE);
    const plex = replaceService(text, 'cloud', { ...SERVICE, app: 'plex' });
    expect(find(plex, 'cloud').app).toBe('plex');
    expect(plex.match(/# hapm-app:/g)).toHaveLength(1);
    const none = replaceService(plex, 'cloud', { ...SERVICE, app: null });
    expect(find(none, 'cloud').app).toBeNull();
    expect(none).not.toContain(APP_LINE_PREFIX);
    expect(removeService(text, 'cloud')).not.toContain(APP_LINE_PREFIX);
  });

  it('liest eine unbekannte Kennung als keine', () => {
    const text = addService(BASE, SERVICE).replace(`${APP_LINE_PREFIX} nextcloud`, `${APP_LINE_PREFIX} gibt-es-nicht`);
    expect(find(text, 'cloud').app).toBeNull();
  });

  it('nimmt nur bekannte Anwendungen an', () => {
    expect(validateCreateInput({ ...SERVICE, app: 'gibt-es-nicht' })?.text).toContain('Diese Anwendung kennt HAPM nicht');
    expect(readServiceInput({ ...SERVICE, app: ' Plex ' }).app).toBe('plex');
    expect(readServiceInput({ ...SERVICE, app: '' }).app).toBeNull();
    expect(readServiceInput({ ...SERVICE, app: undefined }).app).toBeNull();
  });

  it('gibt es nicht bei einer Weiterleitung', () => {
    const redirect: CreateServiceInput = {
      ...SERVICE,
      servers: [],
      routes: [],
      redirect: { to: 'https://example.org', keepPath: false, permanent: false },
    };
    expect(validateCreateInput(redirect)?.text).toContain('Weiterleitung');
    expect(readServiceInput(redirect).app).toBeNull();
  });
});

describe('appUsage', () => {
  it('sammelt je Anwendung die Ziele, ihre Backends samt Pfad-Regeln und Domains', () => {
    const text = addService(
      addService(BASE, SERVICE),
      { ...SERVICE, id: 'shop', domains: ['shop.example.org'], routes: [], app: 'wordpress' }
    );
    const uses = appUsage(parseHaproxyConfig(text));
    expect(uses.map((use) => use.app.id)).toEqual(['nextcloud', 'wordpress']);
    expect(uses[0]).toMatchObject({
      services: [{ id: 'cloud', domains: ['cloud.example.org', '*.files.example.org'] }],
      backends: ['cloud', 'cloud_push'],
      domains: ['cloud.example.org', '*.files.example.org'],
    });
    expect(appUsage(parseHaproxyConfig(BASE))).toEqual([]);
  });
});
