/**
 * Ab dieser Länge steht ein erklärender Text nicht mehr sichtbar da, sondern hinter dem „i".
 * Gut 70 Zeichen sind ein Satz auf einer Zeile einer Karte. Länger, und die Erklärung
 * drängt das, worum es geht (Diagramm, Feld), nach unten.
 */
export const LONG_TEXT = 72

/**
 * Teilt einen Hinweis auf: kurz bleibt er sichtbar (`visible`), lang wandert er ins „i"
 * (`hint`). Kein Text, kein Teil. Was kein reiner Text ist (mit Links, Code), bleibt immer
 * sichtbar: in einem Tooltip ginge es verloren.
 */
export function splitHint<T>(text: T | undefined): { visible: T | undefined; hint: string | undefined } {
  if (typeof text === "string" && text.replace(/\s+/g, " ").trim().length > LONG_TEXT) {
    return { visible: undefined, hint: text }
  }
  return { visible: text, hint: undefined }
}
