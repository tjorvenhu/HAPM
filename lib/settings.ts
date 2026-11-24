import { getSingleton, updateDocument } from './db';
import { ApiError } from './api';
import { encrypt } from './crypto';
import { validateEmail, validateHostname } from './validation';
import { DEFAULT_SMTP_PORT, SMTP_SECURITIES, parseSender } from './mail/config';
import { rememberPublicUrl } from './mail/installation';
import {
  COLLECTIONS,
  NOTIFICATION_EVENT_TYPES,
  SETTINGS_ID,
  type NotificationEventType,
  type Settings,
  type SmtpSecurity,
} from './types';

type SettingsData = Omit<Settings, '$id' | '$createdAt' | '$updatedAt'>;

function allEvents(enabled: boolean): Record<NotificationEventType, boolean> {
  return Object.fromEntries(NOTIFICATION_EVENT_TYPES.map((type) => [type, enabled])) as Record<
    NotificationEventType,
    boolean
  >;
}

const DEFAULTS: SettingsData = {
  acmeEmail: null,
  publicUrl: null,
  autoUpdateHaproxy: false,
  autoUpdateTime: '04:00',
  smtpHost: null,
  smtpPort: DEFAULT_SMTP_PORT,
  smtpSecurity: 'starttls',
  smtpUser: null,
  smtpPass: null,
  mailFrom: null,
  notifyRecipients: [],
  notifyEvents: allEvents(true),
};

/**
 * Eine gelesene Zeile mit den Vorgaben für alles, was ihr fehlt.
 *
 * `getSingleton` setzt die Vorgaben nur beim Anlegen. Ein Feld, das später
 * dazukam, fehlt in einer älteren Zeile oder ist `null`, und ein Ereignis, das
 * später dazukam, fehlt in `notifyEvents`: beides gilt dann als Vorgabe.
 */
export function withDefaults(row: Partial<Settings>): SettingsData {
  const merged = { ...DEFAULTS, ...row } as SettingsData;
  return {
    ...merged,
    autoUpdateHaproxy: merged.autoUpdateHaproxy ?? DEFAULTS.autoUpdateHaproxy,
    autoUpdateTime: merged.autoUpdateTime ?? DEFAULTS.autoUpdateTime,
    smtpPort: merged.smtpPort ?? DEFAULTS.smtpPort,
    smtpSecurity: merged.smtpSecurity ?? DEFAULTS.smtpSecurity,
    notifyRecipients: Array.isArray(merged.notifyRecipients) ? merged.notifyRecipients : [],
    notifyEvents: { ...DEFAULTS.notifyEvents, ...(merged.notifyEvents ?? {}) },
  };
}

export async function getSettings(): Promise<Settings> {
  const row = await getSingleton<Settings>(COLLECTIONS.SETTINGS, SETTINGS_ID, DEFAULTS);
  const settings = { ...row, ...withDefaults(row) };
  rememberPublicUrl(settings.publicUrl);
  return settings;
}

/** Was der Browser von den Einstellungen sieht: alles außer dem SMTP-Passwort. */
export interface SettingsView extends Omit<SettingsData, 'smtpPass'> {
  smtpPassSet: boolean;
  /** Der Port, auf dem HAPM lauscht. `null`, wenn er nicht gesetzt ist. */
  listenPort: number | null;
}

export function settingsView(settings: Settings): SettingsView {
  const port = Number.parseInt(process.env.PORT ?? '', 10);
  return {
    acmeEmail: settings.acmeEmail,
    publicUrl: settings.publicUrl,
    autoUpdateHaproxy: settings.autoUpdateHaproxy,
    autoUpdateTime: settings.autoUpdateTime,
    smtpHost: settings.smtpHost,
    smtpPort: settings.smtpPort,
    smtpSecurity: settings.smtpSecurity,
    smtpUser: settings.smtpUser,
    smtpPassSet: Boolean(settings.smtpPass),
    mailFrom: settings.mailFrom,
    notifyRecipients: settings.notifyRecipients,
    notifyEvents: settings.notifyEvents,
    listenPort: Number.isInteger(port) ? port : null,
  };
}

export function validateTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/**
 * Die Adresse von HAPM in der Form, in der sie gespeichert wird:
 * `https://hapm.example.org`, klein, ohne Pfad und ohne Schrägstrich am Ende.
 *
 * Nur `https`: an der Adresse hängen Passkeys, und die gibt es nur über eine
 * verschlüsselte Verbindung. Ein Schrägstrich am Ende wird abgeschnitten, weil
 * ihn jede kopierte Adresse trägt. Ein Pfad wird abgelehnt und nicht
 * abgeschnitten: wer einen eingibt, erwartet HAPM dort, und das geht nicht.
 */
export function normalizePublicUrl(input: string): string {
  const raw = input.trim();
  if (!/^https:\/\//i.test(raw)) {
    throw new ApiError('Die Adresse von HAPM beginnt mit https://, zum Beispiel https://hapm.example.org.');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError('Die Adresse von HAPM ist keine gültige Adresse.');
  }
  if (url.username || url.password) {
    throw new ApiError('Die Adresse von HAPM darf keine Zugangsdaten enthalten.');
  }
  if (url.pathname !== '/' || url.search || url.hash || /[?#]/.test(raw)) {
    throw new ApiError('Die Adresse von HAPM besteht nur aus https:// und der Domain, ohne Pfad dahinter.');
  }
  const host = url.hostname;
  if (host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    throw new ApiError('Die Adresse von HAPM braucht einen Domainnamen. An eine IP-Adresse lässt sich kein Passkey binden.');
  }
  if (!validateHostname(host)) {
    throw new ApiError('Die Adresse von HAPM enthält keinen gültigen Domainnamen.');
  }
  return url.origin;
}

/** Schema, Domain und gegebenenfalls Port: `https://hapm.example.org`. `null`, solange nichts eingerichtet ist. */
export function publicOrigin(settings: Pick<Settings, 'publicUrl'>): string | null {
  if (!settings.publicUrl) return null;
  try {
    const url = new URL(settings.publicUrl);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** Nur die Domain, ohne Port: daran werden Passkeys gebunden. */
export function publicHost(settings: Pick<Settings, 'publicUrl'>): string | null {
  const origin = publicOrigin(settings);
  return origin ? new URL(origin).hostname : null;
}

export const MAX_RECIPIENTS = 20;

/** Empfänger ohne Leerraum und ohne Doppelte. Die Schreibweise der ersten Nennung bleibt. */
export function normalizeRecipients(input: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of input) {
    if (typeof entry !== 'string') throw new ApiError('Ein Empfänger ist eine E-Mail-Adresse.');
    const address = entry.trim();
    if (!address) continue;
    if (!validateEmail(address)) throw new ApiError(`„${address}“ ist keine gültige E-Mail-Adresse.`);
    if (seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    out.push(address);
  }
  if (out.length > MAX_RECIPIENTS) throw new ApiError(`Mehr als ${MAX_RECIPIENTS} Empfänger gehen nicht.`);
  return out;
}

export interface SettingsInput {
  acmeEmail?: string | null;
  publicUrl?: string | null;
  autoUpdateHaproxy?: boolean;
  autoUpdateTime?: string;
  smtpHost?: string | null;
  smtpPort?: number;
  smtpSecurity?: SmtpSecurity;
  smtpUser?: string | null;
  /** Im Klartext. `null` löscht das gespeicherte, leer oder ausgelassen lässt es stehen. */
  smtpPass?: string | null;
  mailFrom?: string | null;
  notifyRecipients?: string[];
  /** Nur die Schalter, die sich ändern sollen. */
  notifyEvents?: Partial<Record<NotificationEventType, boolean>>;
}

/**
 * Aus einer Eingabe das, was gespeichert wird. Rein bis auf `encryptPass`, das
 * hereingereicht wird: so lässt sich jede Regel ohne Datenbank und ohne
 * Schlüssel prüfen (`tests/mail/settings.test.ts`).
 */
export function settingsPatch(
  input: SettingsInput,
  current: Pick<Settings, 'notifyEvents'>,
  encryptPass: (plaintext: string) => string
): Partial<SettingsData> {
  const patch: Partial<SettingsData> = {};

  if (input.acmeEmail !== undefined) {
    const email = input.acmeEmail?.trim() || null;
    if (email && !validateEmail(email)) throw new ApiError('Die E-Mail-Adresse für Let\'s Encrypt ist ungültig.');
    patch.acmeEmail = email;
  }
  if (input.publicUrl !== undefined) {
    const value = input.publicUrl?.trim() || null;
    patch.publicUrl = value ? normalizePublicUrl(value) : null;
  }
  if (input.autoUpdateHaproxy !== undefined) patch.autoUpdateHaproxy = Boolean(input.autoUpdateHaproxy);
  if (input.autoUpdateTime !== undefined) {
    if (!validateTime(input.autoUpdateTime)) throw new ApiError('Die Uhrzeit hat nicht die Form HH:MM.');
    patch.autoUpdateTime = input.autoUpdateTime;
  }

  if (input.smtpHost !== undefined) {
    const host = input.smtpHost?.trim().toLowerCase() || null;
    if (host && !validateHostname(host)) throw new ApiError('Der SMTP-Server ist kein gültiger Name und keine gültige Adresse.');
    patch.smtpHost = host;
  }
  if (input.smtpPort !== undefined) {
    if (!Number.isInteger(input.smtpPort) || input.smtpPort < 1 || input.smtpPort > 65535) {
      throw new ApiError('Der SMTP-Port ist eine Zahl zwischen 1 und 65535.');
    }
    patch.smtpPort = input.smtpPort;
  }
  if (input.smtpSecurity !== undefined) {
    if (!SMTP_SECURITIES.includes(input.smtpSecurity)) {
      throw new ApiError('Die Verschlüsselung ist STARTTLS, TLS oder keine.');
    }
    patch.smtpSecurity = input.smtpSecurity;
  }
  if (input.smtpUser !== undefined) {
    const user = input.smtpUser?.trim() || null;
    if (user && (user.length > 320 || /[\r\n]/.test(user))) throw new ApiError('Der SMTP-Benutzer ist ungültig.');
    patch.smtpUser = user;
  }
  if (input.smtpPass === null) patch.smtpPass = null;
  else if (input.smtpPass) {
    if (input.smtpPass.length > 1024) throw new ApiError('Das SMTP-Passwort ist zu lang.');
    patch.smtpPass = encryptPass(input.smtpPass);
  }
  if (input.mailFrom !== undefined) {
    const from = input.mailFrom?.trim() || null;
    if (from && !parseSender(from)) {
      throw new ApiError('Der Absender ist eine E-Mail-Adresse, wahlweise mit Namen davor: HAPM <hapm@example.org>.');
    }
    patch.mailFrom = from;
  }

  if (input.notifyRecipients !== undefined) {
    if (!Array.isArray(input.notifyRecipients)) throw new ApiError('Die Empfänger sind eine Liste von Adressen.');
    patch.notifyRecipients = normalizeRecipients(input.notifyRecipients);
  }
  if (input.notifyEvents !== undefined) {
    const next = { ...current.notifyEvents };
    for (const [type, enabled] of Object.entries(input.notifyEvents)) {
      if (!(NOTIFICATION_EVENT_TYPES as readonly string[]).includes(type)) {
        throw new ApiError(`Das Ereignis „${type}“ gibt es nicht.`);
      }
      if (typeof enabled !== 'boolean') throw new ApiError('Der Schalter eines Ereignisses kennt nur an und aus.');
      next[type as NotificationEventType] = enabled;
    }
    patch.notifyEvents = next;
  }

  return patch;
}

export async function updateSettings(input: SettingsInput): Promise<Settings> {
  const current = await getSettings();
  const patch = settingsPatch(input, current, encrypt);
  await updateDocument<Settings>(COLLECTIONS.SETTINGS, SETTINGS_ID, patch);
  return getSettings();
}
