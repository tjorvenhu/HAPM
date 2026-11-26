import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Die Meldungen des Reverse-Proxys in der Sprache der Anfrage.
 *
 * Geprüft wird der Weg, den eine Route nimmt: Prüfung oder Textänderung in
 * `lib/haproxy/`, dann `ApiError`, dann `handleError`. Ohne Sprache bleibt es
 * Deutsch, mit `Accept-Language: en` kommt der Satz englisch und mit den
 * eingesetzten Werten heraus. Kopfzeilen und Sitzung sind nachgebaut wie in
 * `tests/i18n/server.test.ts`.
 */

const request = vi.hoisted(() => ({ acceptLanguage: null as string | null }));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(request.acceptLanguage ? { 'accept-language': request.acceptLanguage } : {}),
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock('@/lib/session', () => ({ getSession: async () => ({ userId: '' }) }));
vi.mock('@/lib/auth/users', () => ({ getUserLocale: async () => null }));

const { ApiError, handleError } = await import('@/lib/api');
const { HaproxyConfigError, removeService, validateCreateInput, validateScopeName } = await import(
  '@/lib/haproxy/config'
);
const { refuseSurfaceDelete } = await import('@/lib/haproxy/protected');
const { planChallenge } = await import('@/lib/haproxy/challenge');
const { stepsAsLog } = await import('@/lib/haproxy/runner');
const { createTranslator } = await import('@/lib/i18n');

beforeEach(() => {
  request.acceptLanguage = null;
});

async function errorOf(err: unknown): Promise<string> {
  const response = await handleError(err);
  return ((await response.json()) as { error: string }).error;
}

/** Wie die Routen einen Fehler der Textänderung weiterreichen. */
function asRouteError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err instanceof HaproxyConfigError ? new ApiError(err, 409) : err;
  }
  throw new Error('Es wurde nichts geworfen.');
}

describe('Meldungen des Reverse-Proxys über handleError', () => {
  it('reicht einen HaproxyConfigError mit Werten auf Englisch weiter', async () => {
    const err = asRouteError(() => removeService('', 'shop'));
    expect(await errorOf(err)).toBe('Der Dienst "shop" steht nicht in /etc/haproxy/haproxy.cfg.');

    request.acceptLanguage = 'en-US,en;q=0.9';
    expect(await errorOf(err)).toBe('The target "shop" is not in /etc/haproxy/haproxy.cfg.');
  });

  it('übersetzt die Prüfung eines Ziels', async () => {
    const invalid = validateCreateInput({
      scope: 'KUNDEN',
      id: 'shop',
      domains: ['shop.example.org'],
      servers: [{ name: '', target: '10.0.0.1', weight: null }],
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
      healthcheck: false,
      backendTls: 'off',
    });
    expect(invalid).not.toBeNull();

    request.acceptLanguage = 'en';
    expect(await errorOf(new ApiError(invalid!))).toBe('Invalid backend target: 10.0.0.1. Expected host:port.');
  });

  it('übersetzt den Namen einer Gruppe samt Grenze', async () => {
    request.acceptLanguage = 'en';
    expect(await errorOf(new ApiError(validateScopeName('a')!))).toBe(
      'The group name needs at least two characters.'
    );
    expect(await errorOf(new ApiError(validateScopeName('x'.repeat(30))!))).toBe(
      'The group name is limited to 24 characters.'
    );
  });

  it('nennt beim Schutz der Oberfläche Adresse und Ausweg', async () => {
    const surface = { serviceId: 'hapm', scope: 'HAPM', host: 'hapm.example.org', url: 'https://hapm.example.org' };
    const refused = refuseSurfaceDelete(surface, 'hapm')!;

    request.acceptLanguage = 'en';
    const text = await errorOf(new ApiError(refused, 409));
    expect(text).toContain('(https://hapm.example.org)');
    expect(text).toContain('change it under General');
    expect(text).not.toContain('setup');
  });

  it('übersetzt, warum sich ein Zertifikat nicht ausstellen lässt', async () => {
    const plan = planChallenge(
      ['*.example.org'],
      { exposure: 'public', dnsHook: 'dns_hetznercloud', source: 'acme', acmeServer: 'letsencrypt', httpReachable: false },
      ['dns_cf']
    );
    expect(plan.method).toBe('unavailable');
    if (plan.method !== 'unavailable') return;

    request.acceptLanguage = 'en';
    expect(await errorOf(new ApiError(plan.message, 409))).toBe(
      'The DNS hook "dns_hetznercloud" is not set up. Available: dns_cf.'
    );
  });
});

describe('stepsAsLog', () => {
  const steps = [
    { label: 'DNS-Einträge entfernen', ok: false, detail: 'Zone nicht erreichbar: 503' },
    { label: 'DNS-Eintrag app.example.org', ok: true, detail: 'Entfernt.' },
  ];

  it('bleibt ohne Übersetzer deutsch', () => {
    expect(stepsAsLog(steps)).toBe(
      '[fehler] DNS-Einträge entfernen\n    Zone nicht erreichbar: 503\n[ok] DNS-Eintrag app.example.org\n    Entfernt.'
    );
  });

  it('übersetzt feste Beschriftungen und lässt Texte mit Werten stehen', () => {
    const { t } = createTranslator('en');
    const log = stepsAsLog(steps, t);
    expect(log).toContain('[error] Remove DNS records');
    // Gespeichert mit eingesetztem Wert: bleibt, wie es geschrieben wurde.
    expect(log).toContain('    Zone nicht erreichbar: 503');
    expect(log).toContain('[ok] DNS-Eintrag app.example.org');
  });

  it('kennzeichnet einen laufenden Schritt samt bisheriger Ausgabe', () => {
    const { t } = createTranslator('en');
    const running = [{ label: 'Zertifikat wird ausgestellt', ok: true, running: true, detail: 'Verifying: app.example.org' }];
    expect(stepsAsLog(running)).toBe('[läuft] Zertifikat wird ausgestellt\n    Verifying: app.example.org');
    expect(stepsAsLog(running, t)).toBe('[running] Issuing certificate\n    Verifying: app.example.org');
  });
});
