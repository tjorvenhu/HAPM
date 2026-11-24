/**
 * Die Regeln der globalen Suche (Strg K), ohne Datenbank und ohne React.
 *
 * Mehrere Stellen brauchen dieselbe Antwort: die Route, die Ziele und
 * TCP-Weiterleitungen durchsucht, die Palette im Browser, die die Seiten der
 * Navigation selbst filtert, und die Filter der Listen. Deshalb ohne einen
 * einzigen Import.
 *
 * Mehrere Wörter müssen alle vorkommen, in beliebiger Reihenfolge und über die
 * Felder hinweg: „shop 10.0" findet das Ziel, dessen Name das eine und dessen
 * Adresse das andere trägt.
 */

export interface SearchItem {
  title: string;
  subtitle?: string;
  href: string;
}

export interface SearchGroup {
  label: string;
  items: SearchItem[];
}

/** Darunter wird nicht gesucht: ein einzelner Buchstabe trifft fast alles. */
export const SEARCH_MIN_LENGTH = 2;

/** Treffer je Bereich. Die Palette ist ein Sprungbrett, keine Liste. */
export const SEARCH_MAX_PER_GROUP = 6;

/** Die Suchwörter einer Eingabe, klein geschrieben. */
export function searchWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Kommt jedes Wort in mindestens einem der Felder vor? Ohne Wörter: nein. */
export function matchesSearch(
  fields: (string | number | null | undefined)[],
  words: string[]
): boolean {
  if (words.length === 0) return false;
  const hay = fields
    .filter((field) => field !== null && field !== undefined && field !== '')
    .join(' ')
    .toLowerCase();
  return words.every((word) => hay.includes(word));
}

/**
 * Die Treffer eines Bereichs, begrenzt auf `SEARCH_MAX_PER_GROUP`.
 *
 * Ein Treffer im Titel steht vor einem, der nur über ein Nebenfeld passt: wer
 * „shop" tippt, meint eher das Ziel, das so heißt, als eines, dessen Adresse
 * zufällig das Wort enthält.
 */
export function searchRows<T>(
  rows: T[],
  words: string[],
  fieldsOf: (row: T) => (string | number | null | undefined)[],
  toItem: (row: T) => SearchItem
): SearchItem[] {
  const inTitle: SearchItem[] = [];
  const elsewhere: SearchItem[] = [];
  for (const row of rows) {
    if (!matchesSearch(fieldsOf(row), words)) continue;
    const item = toItem(row);
    (matchesSearch([item.title], words) ? inTitle : elsewhere).push(item);
  }
  return [...inTitle, ...elsewhere].slice(0, SEARCH_MAX_PER_GROUP);
}
