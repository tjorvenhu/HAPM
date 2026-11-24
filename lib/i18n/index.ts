/**
 * Mehrsprachigkeit, der reine Teil: überall importierbar (Server, Browser,
 * Mails, statische Seiten). Die Sprache einer Anfrage steht in `./server`, der
 * Provider und `useT()` für den Browser in `./react`. Regeln: docs/i18n.md.
 */

export * from './locale';
export * from './translate';
export * from './format';
