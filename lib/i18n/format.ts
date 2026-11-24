/**
 * Zahlen, Datum, Zeitspannen und Größen in der Sprache der Oberfläche.
 *
 * Die eine Stelle dafür. `components/system/format.ts` und
 * `ui/charts/palette.ts` reichen hierher durch, `toLocaleString('de-DE')` an
 * einer Seite ist ein Rest, der umgestellt wird (docs/i18n.md).
 *
 * Rein wie `./translate.ts`: auch für Mails und den Server.
 */

import { INTL_TAGS, type Locale } from './locale';
import { plural, translate } from './translate';

/** Was dasteht, wenn ein Wert fehlt. */
export const MISSING = '–';

const numberFormats = new Map<string, Intl.NumberFormat>();

function numberFormat(locale: Locale, digits: number): Intl.NumberFormat {
  const key = `${locale}:${digits}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(INTL_TAGS[locale], { minimumFractionDigits: digits, maximumFractionDigits: digits });
    numberFormats.set(key, format);
  }
  return format;
}

/** Zahl mit Tausendertrennung der Sprache, standardmäßig ohne Nachkommastellen. */
export function formatNumber(locale: Locale, value: number, digits = 0): string {
  return numberFormat(locale, digits).format(value);
}

/**
 * Ein Anteil in Prozent, `0.5` wird „50 %" bzw. „50%". Unter 10 % mit einer
 * Nachkommastelle, wenn `digits` fehlt.
 */
export function formatShare(locale: Locale, share: number | null, digits?: number): string {
  if (share === null) return MISSING;
  const percent = share * 100;
  const places = digits ?? (percent > 0 && percent < 10 ? 1 : 0);
  // Deutsch setzt ein Leerzeichen vor das Prozentzeichen, Englisch nicht.
  return `${formatNumber(locale, percent, places)}${locale === 'de' ? ' %' : '%'}`;
}

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const DATE: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit', year: 'numeric' };
const TIME: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };

/**
 * Ein Datum: „24.11.2026" bzw. „11/24/2026". `null` wird „Unbekannt", ein
 * unlesbarer Wert bleibt, wie er kam.
 */
export function formatDate(locale: Locale, value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') return translate(locale, 'Unbekannt');
  const date = toDate(value);
  return date ? date.toLocaleDateString(INTL_TAGS[locale], DATE) : String(value);
}

/** Datum und Uhrzeit: „24.11.2026, 14:03" bzw. „11/24/2026, 02:03 PM". */
export function formatDateTime(locale: Locale, value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') return translate(locale, 'Unbekannt');
  const date = toDate(value);
  return date ? date.toLocaleString(INTL_TAGS[locale], { ...DATE, ...TIME }) : String(value);
}

/** Nur die Uhrzeit, mit Sekunden, wenn `seconds`. */
export function formatTime(locale: Locale, value: string | number | Date, seconds = false): string {
  const date = toDate(value);
  if (!date) return String(value);
  return date.toLocaleTimeString(INTL_TAGS[locale], seconds ? { ...TIME, second: '2-digit' } : TIME);
}

/** Datum und Uhrzeit, mittellang: „24.11.2026, 14:03" bzw. „Nov 24, 2026, 2:03 PM". */
export function formatDateTimeMedium(locale: Locale, value: string | number | Date): string {
  const date = toDate(value);
  if (!date) return String(value);
  return date.toLocaleString(INTL_TAGS[locale], { dateStyle: 'medium', timeStyle: 'short' });
}

/** Tag und Monat ohne Jahr, etwa an einer Achse: „24.11." bzw. „11/24". */
export function formatDayMonth(locale: Locale, value: string | number | Date): string {
  const date = toDate(value);
  if (!date) return String(value);
  return date.toLocaleDateString(INTL_TAGS[locale], { day: '2-digit', month: '2-digit' });
}

/**
 * „vor 3 Minuten" bzw. „3 minutes ago". Unter einer Minute steht kein
 * Sekundenzähler, der bei jedem Laden springt.
 */
export function formatRelative(locale: Locale, now: number, value: string | null): string {
  if (!value) return translate(locale, 'Unbekannt');
  const then = Date.parse(value);
  if (Number.isNaN(then)) return value;
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return translate(locale, 'vor weniger als einer Minute');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return plural(locale, minutes, { one: 'vor {count} Minute', other: 'vor {count} Minuten' });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return plural(locale, hours, { one: 'vor {count} Stunde', other: 'vor {count} Stunden' });
  return plural(locale, Math.floor(hours / 24), { one: 'vor {count} Tag', other: 'vor {count} Tagen' });
}

/** Eine Laufzeit seit `value`: „3 Tage 4 Std.", „5 Std. 12 Min.", „12 Min.". */
export function formatDuration(locale: Locale, now: number, value: string | null): string {
  if (!value) return translate(locale, 'Unbekannt');
  const then = Date.parse(value);
  if (Number.isNaN(then)) return translate(locale, 'Unbekannt');
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  if (minutes < 1) return translate(locale, 'unter 1 Min.');
  if (minutes < 60) return translate(locale, '{minutes} Min.', { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return translate(locale, '{hours} Std. {minutes} Min.', { hours, minutes: minutes % 60 });
  const days = plural(locale, Math.floor(hours / 24), { one: '{count} Tag', other: '{count} Tage' });
  return translate(locale, '{days} {hours} Std.', { days, hours: hours % 24 });
}

/** Ganze Dinge (Anfragen, Zeilen): Tausendertrennung, sonst nichts. */
export function formatCount(locale: Locale, value: number): string {
  return formatNumber(locale, Math.round(value));
}

/**
 * Große Anzahlen an einer Achse: „1,2 Mio." bzw. „1.2M". An einer schmalen
 * Achse bricht die volle Zahl sonst um.
 */
export function formatCountShort(locale: Locale, value: number): string {
  const rounded = Math.round(value);
  if (rounded >= 1_000_000) return translate(locale, '{value} Mio.', { value: formatNumber(locale, rounded / 1_000_000, 1) });
  if (rounded >= 10_000) return translate(locale, '{value} Tsd.', { value: formatNumber(locale, rounded / 1000, 1) });
  return formatNumber(locale, rounded);
}

/** Kilobyte in der passenden Einheit (1024er-Schritte, wie die Statistik sie führt). */
export function formatKb(locale: Locale, value: number): string {
  if (value >= 1024 * 1024) return `${formatNumber(locale, value / 1024 / 1024, 1)} GB`;
  if (value >= 1024) return `${formatNumber(locale, value / 1024, 1)} MB`;
  return `${formatNumber(locale, Math.round(value))} KB`;
}

/** Bytes in der passenden Einheit. */
export function formatBytes(locale: Locale, value: number): string {
  return formatKb(locale, value / 1024);
}

/** Millisekunden, ab einer Sekunde in Sekunden: „2400 ms" liest niemand als zweieinhalb Sekunden. */
export function formatMs(locale: Locale, value: number): string {
  if (value >= 1000) return `${formatNumber(locale, value / 1000, 1)} s`;
  return `${formatNumber(locale, Math.round(value))} ms`;
}
