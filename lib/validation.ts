/**
 * Input validation.
 *
 * These are semantic checks — "is this plausibly a hostname". They are NOT the
 * defence against command injection: that is lib/shell.ts, which escapes every
 * argument regardless. Validation you have to remember to call is not a
 * control.
 */

import { msgid } from './i18n/translate';

/** Validate a hostname or IP address. */
export function validateHostname(host: string): boolean {
  if (!host || host.length > 253) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return host.split('.').every((o) => Number(o) <= 255);
  }
  if (/^\[?[a-fA-F0-9:]+\]?$/.test(host) && (host.match(/:/g) || []).length >= 2) return true;
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(
    host
  );
}

/** Validate a display name (server, repository, group, plan). */
export function validateName(name: string): boolean {
  if (!name || name.length > 255) return false;
  return /^[a-zA-Z0-9äöüÄÖÜß\s\-_.]+$/.test(name);
}

export function validateEmail(email: string): boolean {
  if (!email || email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Die Kontaktadresse des ACME-Kontos. Strenger als `validateEmail`: acme.sh
 * schreibt sie als `CA_EMAIL='…'` in eine Datei, die es später als Shell liest.
 * Ein Apostroph oder `$` darin machte die Datei kaputt oder zu einem Kommando.
 * Erlaubt ist deshalb nur, was in einer üblichen Adresse vorkommt (wie bei den
 * Zugangsdaten der DNS-Hooks, `lib/haproxy/dns-credentials.ts`).
 */
export function validateAcmeEmail(email: string): boolean {
  if (!email || email.length > 254) return false;
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(email);
}

/**
 * Validate password complexity. Returns a German error message, or null if valid.
 * Der Text ist ein Schlüssel (`msgid`): `handleError` übersetzt ihn, wenn er als `ApiError` hinausgeht.
 */
export function validatePassword(password: string): string | null {
  if (!password || password.length < 10) {
    return msgid('Das Passwort muss mindestens 10 Zeichen lang sein.');
  }
  if (!/[A-Z]/.test(password)) return msgid('Das Passwort muss mindestens einen Großbuchstaben enthalten.');
  if (!/[a-z]/.test(password)) return msgid('Das Passwort muss mindestens einen Kleinbuchstaben enthalten.');
  if (!/[0-9]/.test(password)) return msgid('Das Passwort muss mindestens eine Zahl enthalten.');
  return null;
}

/** Validate an IPv4/IPv6 address. */
export function validateIP(ip: string): boolean {
  if (!ip || ip.length > 45) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return ip.split('.').every((o) => Number(o) <= 255);
  }
  return /^[a-fA-F0-9:]+$/.test(ip) && (ip.match(/:/g) || []).length >= 2;
}

/** Validate a CIDR range. */
export function validateIPRange(range: string): boolean {
  const [addr, bits] = range.split('/');
  if (!addr || !bits) return false;
  const prefix = Number(bits);
  if (!Number.isInteger(prefix) || prefix < 0) return false;
  if (addr.includes(':')) return prefix <= 128 && validateIP(addr);
  return prefix <= 32 && validateIP(addr);
}
