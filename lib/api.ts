import { NextResponse } from 'next/server';
import { authErrorMessage } from './auth/errors';
import { interpolate, msg, translate, type Locale, type Message, type Params } from './i18n';
import { getLocale } from './i18n/server';
import { rememberError } from './error-log';

/**
 * Response shape shared by every route: { success, data? , error? }.
 * One place, because a try/catch repeated in every handler drifts: the mapping
 * from thrown Error to status code ends up slightly different in each copy.
 *
 * Meldungen gehen in der Sprache der Anfrage hinaus (`handleError`). `fail()`
 * übersetzt nicht, weil es die Anfrage nicht kennt: eine Meldung für Menschen
 * wird geworfen, `throw new ApiError(msg('…'), status)`. Siehe docs/i18n.md.
 */

export function ok<T>(data?: T) {
  return NextResponse.json({ success: true, data });
}

export function fail(error: string, status = 400) {
  return NextResponse.json({ success: false, error }, { status });
}

/**
 * Marker for "this message is safe to show the user, with this status".
 *
 * Nimmt einen deutschen Text oder eine `Message` mit Platzhaltern (`msg()`).
 * `message` bleibt der deutsche Text samt eingesetzten Werten, für Logs und
 * für Aufrufer, die ihn lesen. Übersetzt wird erst in `handleError`.
 */
export class ApiError extends Error {
  readonly text: string;
  readonly params?: Params;

  constructor(message: string | Message, readonly status = 400) {
    const text = typeof message === 'string' ? message : message.text;
    const params = typeof message === 'string' ? undefined : message.params;
    super(interpolate(text, params));
    this.name = 'ApiError';
    this.text = text;
    this.params = params;
  }

  /** Die Meldung in einer Sprache. Ein Text ohne Eintrag im Wörterbuch bleibt deutsch. */
  localized(locale: Locale): string {
    return translate(locale, this.text, this.params);
  }
}

/** Raised by findServerReferences() guards. Carries the blocking references. */
export class ConflictError extends ApiError {
  constructor(message: string | Message, readonly references: unknown[] = []) {
    super(message, 409);
    this.name = 'ConflictError';
  }
}

/** Die Sprache für die Meldung. Scheitert nie: dann Deutsch. */
async function responseLocale(): Promise<Locale> {
  try {
    return await getLocale();
  } catch {
    return 'de';
  }
}

/**
 * Map a thrown error onto a response. Unknown errors never leak their message:
 * die Antwort nennt eine Kennung, unter der ein angemeldeter Benutzer den Text
 * nachsehen kann (`GET /api/errors/<kennung>`). Was der Benutzer lesen soll,
 * wird deshalb als `ApiError` geworfen, nicht als `Error`.
 *
 * Asynchron, weil die Sprache der Anfrage aus Kopfzeilen und Sitzung kommt.
 * Jede Route schreibt `return handleError(err)`, das bleibt so gültig.
 */
export async function handleError(err: unknown): Promise<NextResponse> {
  const locale = await responseLocale();

  if (err instanceof ConflictError) {
    return NextResponse.json(
      { success: false, error: err.localized(locale), data: { references: err.references } },
      { status: 409 }
    );
  }
  if (err instanceof ApiError) {
    return fail(err.localized(locale), err.status);
  }
  const auth = authErrorMessage(err);
  if (auth) {
    return fail(translate(locale, auth.message), auth.status);
  }
  if (err instanceof Error) {
    if (err.message === 'Unauthorized') return fail(translate(locale, 'Nicht authentifiziert'), 401);
    if (err.message === 'Ungültiger CSRF-Token') return fail(translate(locale, 'Ungültiger CSRF-Token'), 403);
    if (err.message === '2FA-Verifizierung erforderlich') {
      return fail(translate(locale, '2FA-Verifizierung erforderlich'), 403);
    }
  }
  // Alles, was niemand als Meldung geworfen hat: der Text bleibt hier, hinaus
  // geht nur die Kennung (`lib/error-log.ts`).
  const code = rememberError(err);
  return NextResponse.json(
    { success: false, error: translate(locale, 'Unbekannter Fehler. Kennung: {code}', { code }), code },
    { status: 500 }
  );
}

/** Parse and validate a JSON body. Throws ApiError on malformed input. */
export async function jsonBody<T = Record<string, unknown>>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new ApiError(msg('Ungültiger Request-Body'));
  }
}
