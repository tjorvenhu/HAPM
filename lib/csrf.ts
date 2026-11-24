import { randomBytes } from 'crypto';

/** Generate a cryptographically secure CSRF token. */
export function generateCsrfToken(): string {
  return randomBytes(32).toString('hex');
}

/** Validate a CSRF token from a request header against the session token. */
export function validateCsrfToken(
  headerToken: string | null,
  sessionToken: string | undefined
): boolean {
  if (!headerToken || !sessionToken) return false;
  if (headerToken.length !== sessionToken.length) return false;
  let result = 0;
  for (let i = 0; i < headerToken.length; i++) {
    result |= headerToken.charCodeAt(i) ^ sessionToken.charCodeAt(i);
  }
  return result === 0;
}
