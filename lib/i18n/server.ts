/**
 * Die Sprache einer Anfrage, auf dem Server: Server-Komponenten, Routen und
 * `handleError` (`lib/api.ts`).
 *
 * Reihenfolge: die Wahl am Konto der Sitzung, sonst das Cookie `hapm-lang`,
 * sonst `Accept-Language`. Außerhalb einer Anfrage (Start, Scheduler, Tests)
 * gibt es keine Kopfzeilen: dann Deutsch.
 *
 * Sitzung und Konto kommen über einen dynamischen Import. `lib/api.ts`
 * importiert diese Datei, und `lib/auth/users.ts` importiert `lib/api.ts`: ein
 * statischer Import schlösse den Kreis.
 */

import { cookies, headers } from 'next/headers';
import type { NextResponse } from 'next/server';
import { DEFAULT_LOCALE, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, isLocale, resolveLocale, type Locale } from './locale';
import { createTranslator, type Translator } from './translate';

interface RequestLanguage {
  cookie: string | null;
  acceptLanguage: string | null;
}

async function requestLanguage(): Promise<RequestLanguage | null> {
  try {
    const [h, c] = await Promise.all([headers(), cookies()]);
    return { cookie: c.get(LOCALE_COOKIE)?.value ?? null, acceptLanguage: h.get('accept-language') };
  } catch {
    return null;
  }
}

/**
 * Cookie, sonst Browser. Ohne Blick in die Datenbank: für das Wurzel-Layout
 * (`<html lang>`), das bei jeder Seite läuft. Das Cookie spiegelt die Wahl am
 * Konto (gesetzt bei der Anmeldung und beim Umschalten), und `AppShell`
 * gleicht es mit der Sitzung ab, falls es fehlt.
 */
export async function getRequestLocale(): Promise<Locale> {
  const request = await requestLanguage();
  if (!request) return DEFAULT_LOCALE;
  return resolveLocale(request);
}

/** Die Wahl am Konto der Sitzung dieser Anfrage, oder `null`. Scheitert nie nach außen. */
async function sessionLocale(): Promise<Locale | null> {
  try {
    const { getSession } = await import('../session');
    const session = await getSession();
    if (!session.userId) return null;
    const { getUserLocale } = await import('../auth/users');
    return await getUserLocale(session.userId);
  } catch {
    return null;
  }
}

/** Die Sprache dieser Anfrage: Konto, Cookie, Browser. */
export async function getLocale(): Promise<Locale> {
  const request = await requestLanguage();
  if (!request) return DEFAULT_LOCALE;
  return resolveLocale({ user: await sessionLocale(), ...request });
}

/** `t()` und `plural()` in der Sprache dieser Anfrage. */
export async function getT(): Promise<Translator> {
  return createTranslator(await getLocale());
}

/** Das Cookie an eine Antwort hängen, etwa nach der Anmeldung oder dem Umschalten. */
export function setLocaleCookie(response: NextResponse, locale: string | null | undefined): void {
  if (!isLocale(locale)) return;
  response.cookies.set(LOCALE_COOKIE, locale, {
    path: '/',
    maxAge: LOCALE_COOKIE_MAX_AGE,
    sameSite: 'lax',
    httpOnly: false,
  });
}
