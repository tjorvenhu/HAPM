import { INTL_TAGS, type Locale } from './i18n/locale';
import { translate } from './i18n/translate';

/**
 * Der Name eines Landes zu seinem Code aus zwei Buchstaben, in der Sprache der
 * Oberfläche.
 *
 * Die Namen kommen aus `Intl.DisplayNames`, nicht aus einer eigenen Tabelle:
 * die kannte nur gut 60 Länder und nur deutsch. Ein Code, den `Intl` nicht
 * kennt, bleibt als Code stehen, damit ein unbekanntes Land trotzdem als Land
 * zu lesen ist.
 *
 * Die Flaggen zeichnet components/CountryFlag.tsx als SVG: Emoji-Flaggen zeigt
 * Windows nur als Buchstabenpaar.
 */
const NAMES = new Map<Locale, Intl.DisplayNames>();

function displayNames(locale: Locale): Intl.DisplayNames {
  let names = NAMES.get(locale);
  if (!names) {
    names = new Intl.DisplayNames([INTL_TAGS[locale]], { type: 'region', fallback: 'code' });
    NAMES.set(locale, names);
  }
  return names;
}

export function countryName(code: string | undefined | null, locale: Locale = 'de'): string {
  if (!code) return translate(locale, 'Unbekannt');
  const upper = code.toUpperCase();
  try {
    return displayNames(locale).of(upper) ?? upper;
  } catch {
    // Kein gültiger Regionscode (etwa „--" aus einer leeren Zeile).
    return upper;
  }
}
