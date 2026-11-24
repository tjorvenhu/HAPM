/**
 * Die zuletzt gelesene Adresse von HAPM, für den Fuß der Mails.
 *
 * `renderHapmMail` ist synchron und kann die Einstellungen nicht selbst lesen.
 * `getSettings` legt die Adresse deshalb bei jedem Lesen hier ab. Am
 * Prozessobjekt und nicht in einer Modulvariablen: Next lädt ein Modul je
 * Route neu, der Wert soll aber für alle derselbe sein.
 */
const store = globalThis as unknown as { __hapmPublicUrl?: string | null };

export function rememberPublicUrl(publicUrl: string | null): void {
  store.__hapmPublicUrl = publicUrl;
}

/** `null` heißt: keine Adresse eingerichtet, oder die Einstellungen wurden noch nie gelesen. */
export function knownPublicUrl(): string | null {
  return store.__hapmPublicUrl ?? null;
}
