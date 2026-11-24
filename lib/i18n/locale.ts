/**
 * Die Sprachen der Oberfläche und wie eine Anfrage zu ihrer kommt.
 *
 * Ohne einen Import: Server, Browser, Mails und die statischen Seiten von
 * HAProxy brauchen dieselbe Antwort, und keiner davon soll dafür `lib/db`
 * erreichen.
 */

export type Locale = 'de' | 'en';

export const LOCALES: readonly Locale[] = ['de', 'en'];

/** Deutsch ist die Quelle: jeder Text steht im Code auf Deutsch. */
export const DEFAULT_LOCALE: Locale = 'de';

/** Solange die Übersetzung nur zum Teil steht: keine Wahl, kein Umschalter. */
export const UI_LOCALE_FIXED = true;

/**
 * Das Cookie mit der Wahl. Nicht `httpOnly`: der Umschalter vor der Anmeldung
 * setzt es im Browser. Es trägt nichts, was geheim wäre.
 */
export const LOCALE_COOKIE = 'hapm-lang';

/** Ein Jahr. Wer die Sprache einmal wählt, will sie nicht jeden Monat neu wählen. */
export const LOCALE_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

/** Jede Sprache in ihrer eigenen Schreibweise: wer sie sucht, liest sie so. */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = { de: 'Deutsch', en: 'English' };

/** Für `Intl`: Zahlen und Datum. Amerikanisches Englisch, siehe docs/i18n.md. */
export const INTL_TAGS: Readonly<Record<Locale, string>> = { de: 'de-DE', en: 'en-US' };

export function isLocale(value: unknown): value is Locale {
  return value === 'de' || value === 'en';
}

/**
 * Die Sprache aus `Accept-Language`.
 *
 * Deutsch, wenn Deutsch vor Englisch steht oder Englisch fehlt. Englisch, wenn
 * Englisch vorn steht, und auch, wenn der Browser keine der beiden nennt: wer
 * Französisch liest, kommt mit Englisch eher zurecht. Ohne Kopfzeile (curl,
 * Tests) bleibt es bei Deutsch.
 */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale {
  if (!header || !header.trim()) return DEFAULT_LOCALE;

  const ranked = header
    .split(',')
    .map((part, index) => {
      const [tag = '', ...rest] = part.trim().split(';');
      const quality = rest.map((p) => /^\s*q=([\d.]+)\s*$/.exec(p)?.[1]).find(Boolean);
      const q = quality === undefined ? 1 : Number(quality);
      return { language: tag.trim().toLowerCase().split('-')[0], q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((entry) => entry.language && entry.q > 0)
    // Gleiche Gewichtung behält die Reihenfolge der Kopfzeile.
    .sort((a, b) => b.q - a.q || a.index - b.index);

  const german = ranked.findIndex((entry) => entry.language === 'de');
  const english = ranked.findIndex((entry) => entry.language === 'en');
  if (german >= 0 && (english < 0 || german < english)) return 'de';
  return ranked.length > 0 ? 'en' : DEFAULT_LOCALE;
}

/** Die Reihenfolge: Wahl am Konto, sonst Cookie, sonst Browser. */
export function resolveLocale(input: {
  user?: string | null;
  cookie?: string | null;
  acceptLanguage?: string | null;
}): Locale {
  // Bis die Übersetzung vollständig ist, bleibt die Oberfläche deutsch.
  if (UI_LOCALE_FIXED) return DEFAULT_LOCALE;
  if (isLocale(input.user)) return input.user;
  if (isLocale(input.cookie)) return input.cookie;
  return localeFromAcceptLanguage(input.acceptLanguage);
}
