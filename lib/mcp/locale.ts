import { localeFromAcceptLanguage, type Locale } from '../i18n';

/**
 * Die Sprache der Meldungen, die ein Werkzeug zurückgibt.
 *
 * Nicht `getLocale()` wie bei den Routen: ein MCP-Client hat keine Sitzung und
 * kein Cookie, und ohne `Accept-Language` gälte dort Deutsch. Gelesen werden
 * die Meldungen von einem Sprachmodell, dessen Werkzeugbeschreibungen englisch
 * sind. Ohne Kopfzeile deshalb Englisch; wer Deutsch will, schickt
 * `Accept-Language: de`.
 */
export function mcpLocale(request: Request): Locale {
  const header = request.headers.get('accept-language');
  return header && header.trim() ? localeFromAcceptLanguage(header) : 'en';
}
