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

/**
 * Was die Mails aus der Darstellung übernehmen: Name, Akzentfarbe und, wenn
 * es ein eigenes Logo gibt, seine Anzeigegröße. Aus demselben Grund am
 * Prozessobjekt: der Rahmen ist synchron. Gesetzt beim Start und nach dem
 * Speichern der Darstellung (`loadMailBranding` in `lib/mail/branding.ts`).
 */
export interface MailBranding {
  name: string | null;
  /** Die gewählte Farbe. Was daraus in der Mail wird, rechnet `lib/mail/layout.ts`. */
  accent: string | null;
  /** Anzeigegröße des eigenen Logos, `null` ohne. */
  logo: { width: number; height: number } | null;
  /** Ob es eine helle Fassung für dunkles Design gibt. */
  logoDark: boolean;
}

const brandingStore = globalThis as unknown as { __hapmMailBranding?: MailBranding | null };

export function rememberMailBranding(branding: MailBranding | null): void {
  brandingStore.__hapmMailBranding = branding;
}

/** `null`: keine Darstellung, oder sie wurde noch nicht gelesen. */
export function knownMailBranding(): MailBranding | null {
  return brandingStore.__hapmMailBranding ?? null;
}
