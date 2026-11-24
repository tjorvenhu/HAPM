/**
 * Übersetzen: der deutsche Text ist der Schlüssel, das Wörterbuch liefert die
 * andere Sprache. Regeln und Beispiele stehen in docs/i18n.md.
 *
 * Rein, ohne `lib/db` und ohne React: der Server, der Browser, die Mails und
 * die statischen Fehlerseiten benutzen dieselben Funktionen.
 *
 * Fehlt ein Eintrag, steht der deutsche Text da und nie ein Schlüssel.
 * `tests/i18n/dictionary.test.ts` meldet, welche Einträge fehlen.
 */

import { en } from './en';
import { DEFAULT_LOCALE, INTL_TAGS, type Locale } from './locale';

export type Params = Readonly<Record<string, string | number>>;

/**
 * Ein Text, der erst später übersetzt wird: an einer Stelle, die die Sprache
 * nicht kennt (eine Meldung in `lib/`, die die Route erst ausliefert).
 */
export interface Message {
  readonly text: string;
  readonly params?: Params;
}

export type Translatable = string | Message;

/** Die Wörterbücher je Sprache. Deutsch hat keines, es ist die Quelle. */
const DICTIONARIES: Readonly<Record<Locale, Readonly<Record<string, string>> | null>> = {
  de: null,
  en,
};

/**
 * Eine Meldung mit Platzhaltern, für später: `msg('Die Gruppe {name} gibt es
 * schon.', { name })`. Wer sie zeigt, übersetzt sie (`t(message)`,
 * `handleError`).
 */
export function msg(text: string, params?: Params): Message {
  return params ? { text, params } : { text };
}

/**
 * Markiert einen deutschen Text als Schlüssel, ohne ihn hier zu übersetzen.
 * Gibt ihn unverändert zurück. Für Texte, die als Zeichenkette weiterwandern
 * (Beschriftungen in Tabellen, Rückgaben von Prüfungen) und erst beim Zeigen
 * durch `t()` gehen. So findet der Test sie trotzdem.
 */
export function msgid(text: string): string {
  return text;
}

export function isMessage(value: unknown): value is Message {
  return typeof value === 'object' && value !== null && typeof (value as Message).text === 'string';
}

/**
 * `{name}` durch den Wert ersetzen. Ein Platzhalter ohne Wert bleibt stehen,
 * damit der Fehler auffällt. Zahlen werden nicht formatiert: `{port}` soll
 * „8080" bleiben und nicht „8.080" werden. Wer Tausenderpunkte will, gibt
 * `formatNumber(…)` hinein.
 */
export function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole
  );
}

/** Der Eintrag im Wörterbuch, ohne Rückfall. Für Tests und die Suche nach Lücken. */
export function lookup(locale: Locale, text: string): string | undefined {
  const dictionary = DICTIONARIES[locale];
  if (!dictionary) return text;
  return Object.hasOwn(dictionary, text) ? dictionary[text] : undefined;
}

/**
 * Den deutschen Text in die Sprache `locale`, mit Platzhaltern.
 *
 * Nimmt auch eine `Message`. Deren Parameter gelten, `params` ergänzt sie.
 */
export function translate(locale: Locale, text: Translatable, params?: Params): string {
  const source = typeof text === 'string' ? text : text.text;
  const values = typeof text === 'string' ? params : { ...text.params, ...params };
  const template = lookup(locale, source) ?? source;
  return interpolate(template, values);
}

/** Die beiden Formen eines Textes mit Anzahl. `{count}` steht in beiden. */
export interface PluralForms {
  one: string;
  other: string;
}

/**
 * Einzahl oder Mehrzahl, dann übersetzt.
 *
 * Deutsch und Englisch teilen die Regel: genau 1 ist Einzahl, alles andere
 * (auch 0) Mehrzahl. Deshalb reichen zwei Formen, und jede Form ist ein
 * eigener Schlüssel im Wörterbuch. `{count}` kommt mit Tausendertrennung der
 * Sprache hinein.
 *
 * `plural(locale, n, { one: '{count} Ziel', other: '{count} Ziele' })`
 */
export function plural(locale: Locale, count: number, forms: PluralForms, params?: Params): string {
  const form = count === 1 ? forms.one : forms.other;
  return translate(locale, form, { count: new Intl.NumberFormat(INTL_TAGS[locale]).format(count), ...params });
}

/** Übersetzen mit fester Sprache. Was `useT()` und `getT()` liefern. */
export interface Translator {
  locale: Locale;
  t: (text: Translatable, params?: Params) => string;
  plural: (count: number, forms: PluralForms, params?: Params) => string;
}

export function createTranslator(locale: Locale = DEFAULT_LOCALE): Translator {
  return {
    locale,
    t: (text, params) => translate(locale, text, params),
    plural: (count, forms, params) => plural(locale, count, forms, params),
  };
}

/** Eine `Message` auf Deutsch, etwa für ein Log. */
export function germanText(message: Translatable): string {
  return translate(DEFAULT_LOCALE, message);
}
