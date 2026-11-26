/**
 * Die Kennung eines unbekannten Fehlers (`lib/error-log.ts`), etwa `F-3A9C1E`.
 * Rein und ohne Abhängigkeiten: Server und Oberfläche erkennen sie gleich.
 */
export const ERROR_CODE = /^F-[0-9A-F]{6}$/;

/** Die Kennung in einem Meldungstext, oder `null`. */
export function errorCodeIn(text: string | null | undefined): string | null {
  return /\bF-[0-9A-F]{6}\b/.exec(text ?? '')?.[0] ?? null;
}

/** Das Ereignis, mit dem die Oberfläche die Einzelheiten zu einer Kennung öffnet. */
export const ERROR_DETAIL_EVENT = 'hapm:error-detail';

export function openErrorDetail(code: string): void {
  window.dispatchEvent(new CustomEvent(ERROR_DETAIL_EVENT, { detail: code }));
}
