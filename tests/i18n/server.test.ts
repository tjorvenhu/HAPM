import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Die Sprache einer Anfrage auf dem Server und die Meldungen in `handleError`.
 *
 * Kopfzeilen, Sitzung und Konto sind nachgebaut: geprüft wird die Reihenfolge
 * (Konto, Cookie, Browser) und dass eine Meldung in dieser Sprache hinausgeht.
 */

const request = vi.hoisted(() => ({
  inRequest: true,
  cookie: null as string | null,
  acceptLanguage: null as string | null,
  userId: '',
  userLocale: null as 'de' | 'en' | null,
}));

vi.mock('next/headers', () => ({
  headers: async () => {
    if (!request.inRequest) throw new Error('headers was called outside a request scope');
    return new Headers(request.acceptLanguage ? { 'accept-language': request.acceptLanguage } : {});
  },
  cookies: async () => {
    if (!request.inRequest) throw new Error('cookies was called outside a request scope');
    return { get: (name: string) => (name === 'hapm-lang' && request.cookie ? { value: request.cookie } : undefined) };
  },
}));

vi.mock('@/lib/session', () => ({
  getSession: async () => ({ userId: request.userId }),
}));

vi.mock('@/lib/auth/users', () => ({
  getUserLocale: async () => request.userLocale,
}));

const { getLocale, getRequestLocale, getT } = await import('@/lib/i18n/server');
const { ApiError, ConflictError, handleError } = await import('@/lib/api');
const { msg } = await import('@/lib/i18n');
const { authErrorMessage } = await import('@/lib/auth/errors');

beforeEach(() => {
  request.inRequest = true;
  request.cookie = null;
  request.acceptLanguage = null;
  request.userId = '';
  request.userLocale = null;
});

async function errorOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error;
}

describe('getLocale', () => {
  it('ist außerhalb einer Anfrage Deutsch', async () => {
    request.inRequest = false;
    expect(await getLocale()).toBe('de');
    expect(await getRequestLocale()).toBe('de');
  });

  it('folgt dem Browser, wenn nichts anderes gilt', async () => {
    request.acceptLanguage = 'en-US,en;q=0.9';
    expect(await getLocale()).toBe('en');
  });

  it('nimmt das Cookie vor dem Browser', async () => {
    request.acceptLanguage = 'en-US';
    request.cookie = 'de';
    expect(await getLocale()).toBe('de');
  });

  it('nimmt die Wahl am Konto vor dem Cookie', async () => {
    request.cookie = 'de';
    request.userId = 'user_1';
    request.userLocale = 'en';
    expect(await getLocale()).toBe('en');
    // Das Layout sieht nur Cookie und Browser.
    expect(await getRequestLocale()).toBe('de');
  });

  it('liefert t() in der Sprache der Anfrage', async () => {
    request.cookie = 'en';
    const { t, locale } = await getT();
    expect(locale).toBe('en');
    expect(t('Abmelden')).toBe('Sign out');
  });
});

describe('handleError', () => {
  it('bleibt ohne Angabe der Sprache deutsch', async () => {
    request.inRequest = false;
    const response = await handleError(new ApiError(msg('Diese Sprache gibt es nicht.')));
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe('Diese Sprache gibt es nicht.');
  });

  it('übersetzt eine Meldung mit Platzhaltern', async () => {
    request.cookie = 'en';
    const error = new ApiError(msg('Mehr als {max} Passkeys je Konto sind nicht möglich', { max: 10 }), 409);
    // `message` bleibt der deutsche Text, für Logs und Aufrufer.
    expect(error.message).toBe('Mehr als 10 Passkeys je Konto sind nicht möglich');
    const response = await handleError(error);
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toBe('No more than 10 passkeys per account');
  });

  it('schlägt auch einen schlichten Text nach und lässt einen unbekannten deutsch', async () => {
    request.cookie = 'en';
    expect(await errorOf(await handleError(new ApiError('Das Passwort stimmt nicht.')))).toBe('The password is wrong.');
    expect(await errorOf(await handleError(new ApiError('Noch nicht übersetzt.')))).toBe('Noch nicht übersetzt.');
  });

  it('übersetzt ConflictError und die Fehler der Sitzung', async () => {
    request.cookie = 'en';
    const conflict = await handleError(new ConflictError(msg('Dieses Konto gibt es nicht mehr.'), ['x']));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      success: false,
      error: 'This account no longer exists.',
      data: { references: ['x'] },
    });

    const unauthorized = await handleError(new Error('Unauthorized'));
    expect(unauthorized.status).toBe(401);
    expect(await errorOf(unauthorized)).toBe('Not signed in');
  });

  it('macht aus einem Fehler des Anmeldedienstes eine eigene Meldung', async () => {
    request.cookie = 'en';
    const rejected = Object.assign(new Error('Invalid token'), {
      name: 'APIError',
      statusCode: 400,
      body: { code: 'INVALID_TOKEN', message: 'Invalid token' },
    });
    const response = await handleError(rejected);
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe('The link is invalid or has expired. Please request a new one.');
  });
});

describe('authErrorMessage', () => {
  it('erkennt nur Fehler des Anmeldedienstes unter 500', () => {
    expect(authErrorMessage(new Error('x'))).toBeNull();
    expect(authErrorMessage({ name: 'APIError', statusCode: 500, body: { code: 'INVALID_TOKEN' } })).toBeNull();
    expect(authErrorMessage({ name: 'APIError', statusCode: 403, body: { code: 'SOMETHING_NEW' } })).toEqual({
      message: 'Der Anmeldedienst hat die Anfrage abgelehnt.',
      status: 403,
    });
  });
});
