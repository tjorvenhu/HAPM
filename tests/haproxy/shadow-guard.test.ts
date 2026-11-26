import { describe, it, expect } from 'vitest';
import { renderBaseConfig } from '@/lib/haproxy/base-config';
import { addScope, addService, replaceService, type CreateServiceInput } from '@/lib/haproxy/config';
import { assertNothingShadowed } from '@/lib/haproxy/provision';

/**
 * Über Gruppen hinweg ordnet niemand genaue Domains vor Wildcards. Ein Vorgang,
 * nach dem ein Ziel keine Anfrage mehr bekäme, wird deshalb abgelehnt.
 */
const BASE = addScope(addScope(renderBaseConfig({ ipv6: false, errorStatuses: [403, 404] }), 'KUNDEN'), 'INTERN');

function service(scope: string, id: string, domain: string): CreateServiceInput {
  return {
    scope,
    id,
    domains: [domain],
    servers: [{ name: id, target: '10.0.0.5:8080', weight: null }],
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
    healthcheck: true,
    backendTls: 'off',
  };
}

const APP = service('INTERN', 'app', 'app.kunde.example');
const WILD = service('KUNDEN', 'wild', '*.kunde.example');

describe('assertNothingShadowed', () => {
  it('lehnt eine Wildcard ab, die ein Ziel in einer Gruppe weiter unten verdeckte', () => {
    const before = addService(BASE, APP);
    const after = addService(before, WILD);
    expect(() => assertNothingShadowed(before, after, 'wild')).toThrow(/app/);
  });

  it('lehnt ein Ziel ab, das hinter einer Wildcard weiter oben nie eine Anfrage bekäme', () => {
    const before = addService(BASE, WILD);
    const after = addService(before, APP);
    expect(() => assertNothingShadowed(before, after, 'app')).toThrow(/wild/);
  });

  it('lässt beides in derselben Gruppe zu: dort steht die genaue Domain vor der Wildcard', () => {
    const before = addService(BASE, service('KUNDEN', 'app', 'app.kunde.example'));
    const after = addService(before, WILD);
    expect(() => assertNothingShadowed(before, after, 'wild')).not.toThrow();
  });

  it('lässt stehen, was schon verdeckt war, auch wenn das Ziel umbenannt wird', () => {
    const shadowed = addService(addService(BASE, APP), WILD);
    const renamed = replaceService(shadowed, 'app', { ...APP, id: 'app2' });
    expect(() => assertNothingShadowed(shadowed, renamed, 'app2', 'app')).not.toThrow();
    const edited = replaceService(shadowed, 'wild', { ...WILD, tunnel: true });
    expect(() => assertNothingShadowed(shadowed, edited, 'wild', 'wild')).not.toThrow();
  });
});
