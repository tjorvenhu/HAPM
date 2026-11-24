import { NextResponse } from 'next/server';

/**
 * Response shape shared by every route: { success, data? , error? }.
 * One place, because a try/catch repeated in every handler drifts: the mapping
 * from thrown Error to status code ends up slightly different in each copy.
 */

export function ok<T>(data?: T) {
  return NextResponse.json({ success: true, data });
}

export function fail(error: string, status = 400) {
  return NextResponse.json({ success: false, error }, { status });
}

/** Marker for "this message is safe to show the user, with this status". */
export class ApiError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Raised by findServerReferences() guards. Carries the blocking references. */
export class ConflictError extends ApiError {
  constructor(message: string, readonly references: unknown[] = []) {
    super(message, 409);
    this.name = 'ConflictError';
  }
}

/** Map a thrown error onto a response. Unknown errors never leak their message. */
export function handleError(err: unknown) {
  if (err instanceof ConflictError) {
    return NextResponse.json(
      { success: false, error: err.message, data: { references: err.references } },
      { status: 409 }
    );
  }
  if (err instanceof ApiError) {
    return fail(err.message, err.status);
  }
  if (err instanceof Error) {
    if (err.message === 'Unauthorized') return fail('Nicht authentifiziert', 401);
    if (err.message === 'Ungültiger CSRF-Token') return fail(err.message, 403);
    if (err.message === '2FA-Verifizierung erforderlich') return fail(err.message, 403);
    console.error('[api]', err);
    return fail(err.message, 500);
  }
  console.error('[api] Unbekannter Fehler:', err);
  return fail('Unerwarteter Fehler', 500);
}

/** Parse and validate a JSON body. Throws ApiError on malformed input. */
export async function jsonBody<T = Record<string, unknown>>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new ApiError('Ungültiger Request-Body');
  }
}
