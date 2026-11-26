/**
 * Der Text eines gefangenen Fehlers für eine Meldung.
 *
 * Im `catch` einer Handlung landen zwei Sorten: der eigene Wurf mit der Meldung
 * der Route (`throw new Error(body.error)`), und was der Browser wirft. Den
 * zweiten schreibt der Browser, in seiner Sprache und für Entwickler: „Failed
 * to fetch" bei unterbrochener Verbindung (`TypeError`), „Unexpected token <"
 * bei einer Antwort, die kein JSON ist (`SyntaxError`), dazu `DOMException`
 * (Abbruch, Zwischenablage). Für die gilt `fallback`, der Satz der Seite.
 */
export function errorText(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  if (err instanceof TypeError || err instanceof SyntaxError) return fallback;
  if (typeof DOMException !== 'undefined' && err instanceof DOMException) return fallback;
  return err.message || fallback;
}
