import { getSingleton, updateDocument } from './db';
import { deleteAllPasskeys } from './db/auth-tables';
import { ApiError } from './api';
import { encrypt } from './crypto';
import { validateAcmeEmail, validateEmail, validateHostname } from './validation';
import { DEFAULT_SMTP_PORT, SMTP_SECURITIES, parseSender } from './mail/config';
import { rememberPublicUrl } from './mail/installation';
import { isLocale, msg, type Locale } from './i18n';
import { normalizeAcmeDirectory, validateAcmeDirectory } from './acme-server';
import { challengeChoice, type ChallengeChoice } from './haproxy/challenge';
import {
  COLLECTIONS,
  NOTIFICATION_EVENT_TYPES,
  SETTINGS_ID,
  type CertificateSource,
  type Exposure,
  type NotificationEventType,
  type SetupStatus,
  type Settings,
  type SmtpSecurity,
  type UpdateComponent,
} from './types';

type SettingsData = Omit<Settings, '$id' | '$createdAt' | '$updatedAt'>;

function allEvents(enabled: boolean): Record<NotificationEventType, boolean> {
  return Object.fromEntries(NOTIFICATION_EVENT_TYPES.map((type) => [type, enabled])) as Record<
    NotificationEventType,
    boolean
  >;
}

/**
 * Was eine neue Installation selbst aktualisiert: alles außer HAPM. HAProxy
 * prüft vorher die Konfiguration und kommt zurück, wenn der neue Container
 * nicht steht; acme.sh und CrowdSec tragen Fehlerbehebungen und neue Regeln.
 * HAPM ersetzt dabei sich selbst, das bleibt ein Klick.
 */
export const DEFAULT_AUTO_UPDATE: readonly UpdateComponent[] = ['acme', 'crowdsec', 'crowdsec-bouncer', 'haproxy'];

/** Die Reihenfolge der selbsttätigen Updates: HAPM zuletzt, es übergibt sich selbst. */
export const AUTO_UPDATE_ORDER: readonly UpdateComponent[] = ['acme', 'crowdsec', 'crowdsec-bouncer', 'haproxy', 'hapm'];

function readAutoUpdate(row: Partial<Settings>): UpdateComponent[] {
  if (Array.isArray(row.autoUpdate)) {
    return AUTO_UPDATE_ORDER.filter((component) => row.autoUpdate!.includes(component));
  }
  // Eine Zeile von vor der Auswahl: HAProxy nur, wenn es eingeschaltet war.
  // Die übrigen bekommen die neue Vorgabe.
  return DEFAULT_AUTO_UPDATE.filter(
    (component) => component !== 'haproxy' || row.autoUpdateHaproxy === undefined || row.autoUpdateHaproxy === true
  );
}

const DEFAULTS: SettingsData = {
  acmeEmail: null,
  publicUrl: null,
  autoUpdateHaproxy: true,
  autoUpdate: [...DEFAULT_AUTO_UPDATE],
  autoUpdateTime: '04:00',
  smtpHost: null,
  smtpPort: DEFAULT_SMTP_PORT,
  smtpSecurity: 'starttls',
  smtpUser: null,
  smtpPass: null,
  mailFrom: null,
  notifyRecipients: [],
  // Der Tagesbericht ist eine Übersicht, keine Störung: nur, wer ihn will.
  notifyEvents: { ...allEvents(true), crowdsec_report: false },
  mailLocale: 'de',
  // Die Vorgabe ist das Verhalten vor dieser Einstellung: HTTP-01, DNS-01 nur für Wildcards.
  exposure: 'public',
  // Die Vorgabe ist das Verhalten vor diesen Einstellungen: acme.sh, bei Let's Encrypt.
  certificateSource: 'acme',
  acmeDirectory: null,
  acmeHttpReachable: false,
  setupStatus: null,
};

export const EXPOSURES: readonly Exposure[] = ['internal', 'public'];
export const CERTIFICATE_SOURCES: readonly CertificateSource[] = ['acme', 'upload'];
const SETUP_STATUSES: readonly SetupStatus[] = ['open', 'done', 'skipped'];

/**
 * Eine gelesene Zeile mit den Vorgaben für alles, was ihr fehlt.
 *
 * `getSingleton` setzt die Vorgaben nur beim Anlegen. Ein Feld, das später
 * dazukam, fehlt in einer älteren Zeile oder ist `null`, und ein Ereignis, das
 * später dazukam, fehlt in `notifyEvents`: beides gilt dann als Vorgabe.
 */
export function withDefaults(row: Partial<Settings>): SettingsData {
  const merged = { ...DEFAULTS, ...row } as SettingsData;
  const autoUpdate = readAutoUpdate(row);
  return {
    ...merged,
    autoUpdate,
    autoUpdateHaproxy: autoUpdate.includes('haproxy'),
    autoUpdateTime: merged.autoUpdateTime ?? DEFAULTS.autoUpdateTime,
    smtpPort: merged.smtpPort ?? DEFAULTS.smtpPort,
    smtpSecurity: merged.smtpSecurity ?? DEFAULTS.smtpSecurity,
    notifyRecipients: Array.isArray(merged.notifyRecipients) ? merged.notifyRecipients : [],
    notifyEvents: { ...DEFAULTS.notifyEvents, ...(merged.notifyEvents ?? {}) },
    mailLocale: isLocale(merged.mailLocale) ? merged.mailLocale : DEFAULTS.mailLocale,
    exposure: EXPOSURES.includes(merged.exposure) ? merged.exposure : DEFAULTS.exposure,
    certificateSource: CERTIFICATE_SOURCES.includes(merged.certificateSource)
      ? merged.certificateSource
      : DEFAULTS.certificateSource,
    acmeDirectory: typeof merged.acmeDirectory === 'string' && merged.acmeDirectory ? merged.acmeDirectory : null,
    acmeHttpReachable: merged.acmeHttpReachable === true,
    setupStatus: SETUP_STATUSES.includes(merged.setupStatus as SetupStatus) ? merged.setupStatus : null,
  };
}

/** Ob die Übersicht noch an die Einrichtung erinnert. */
export function setupOpen(settings: Pick<Settings, 'setupStatus'>): boolean {
  return settings.setupStatus === 'open';
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
    autoUpdate: settings.autoUpdate,
    autoUpdateTime: settings.autoUpdateTime,
    smtpHost: settings.smtpHost,
    smtpPort: settings.smtpPort,
    smtpSecurity: settings.smtpSecurity,
    smtpUser: settings.smtpUser,
    smtpPassSet: Boolean(settings.smtpPass),
    mailFrom: settings.mailFrom,
    notifyRecipients: settings.notifyRecipients,
    notifyEvents: settings.notifyEvents,
    mailLocale: settings.mailLocale,
    exposure: settings.exposure,
    certificateSource: settings.certificateSource,
    acmeDirectory: settings.acmeDirectory,
    acmeHttpReachable: settings.acmeHttpReachable,
    setupStatus: settings.setupStatus,
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
    throw new ApiError(msg('Die Adresse von HAPM beginnt mit https://, zum Beispiel https://hapm.example.org.'));
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError(msg('Die Adresse von HAPM ist keine gültige Adresse.'));
  }
  if (url.username || url.password) {
    throw new ApiError(msg('Die Adresse von HAPM darf keine Zugangsdaten enthalten.'));
  }
  if (url.pathname !== '/' || url.search || url.hash || /[?#]/.test(raw)) {
    throw new ApiError(msg('Die Adresse von HAPM besteht nur aus https:// und der Domain, ohne Pfad dahinter.'));
  }
  const host = url.hostname;
  if (host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    throw new ApiError(msg('Die Adresse von HAPM braucht einen Domainnamen. An eine IP-Adresse lässt sich kein Passkey binden.'));
  }
  if (!validateHostname(host)) {
    throw new ApiError(msg('Die Adresse von HAPM enthält keinen gültigen Domainnamen.'));
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
    if (typeof entry !== 'string') throw new ApiError(msg('Ein Empfänger ist eine E-Mail-Adresse.'));
    const address = entry.trim();
    if (!address) continue;
    if (!validateEmail(address)) throw new ApiError(msg('„{address}“ ist keine gültige E-Mail-Adresse.', { address }));
    if (seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    out.push(address);
  }
  if (out.length > MAX_RECIPIENTS) throw new ApiError(msg('Mehr als {max} Empfänger gehen nicht.', { max: MAX_RECIPIENTS }));
  return out;
}

export interface SettingsInput {
  acmeEmail?: string | null;
  publicUrl?: string | null;
  autoUpdateHaproxy?: boolean;
  autoUpdate?: UpdateComponent[];
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
  mailLocale?: Locale;
  exposure?: Exposure;
  certificateSource?: CertificateSource;
  /** `null` heißt: zurück zu Let's Encrypt (oder `HAPM_ACME_SERVER`). */
  acmeDirectory?: string | null;
  acmeHttpReachable?: boolean;
  setupStatus?: SetupStatus;
}

const SMTP_TEXT_FIELDS = ['smtpHost', 'smtpUser', 'mailFrom'] as const;

/**
 * Die Felder des SMTP-Kontos aus einem Anfragekörper, nur auf ihre Form
 * geprüft. Was die Werte bedeuten dürfen, prüft `settingsPatch`. Dieselbe
 * Regel unter „Benachrichtigungen" (`/api/settings`) und im Assistenten
 * (`/api/setup/mail`). Ein fehlendes Feld bleibt unverändert.
 */
export function readSmtpInput(body: Record<string, unknown>): SettingsInput {
  const input: SettingsInput = {};
  for (const field of SMTP_TEXT_FIELDS) {
    if (!(field in body)) continue;
    const value = body[field];
    if (value !== null && typeof value !== 'string') throw new ApiError(msg('Das Feld {field} erwartet einen Text.', { field }));
    input[field] = value;
  }
  if ('smtpPort' in body) {
    if (typeof body.smtpPort !== 'number') throw new ApiError(msg('Der SMTP-Port ist eine Zahl zwischen 1 und 65535.'));
    input.smtpPort = body.smtpPort;
  }
  if ('smtpSecurity' in body) {
    if (typeof body.smtpSecurity !== 'string') throw new ApiError(msg('Die Verschlüsselung ist STARTTLS, TLS oder keine.'));
    input.smtpSecurity = body.smtpSecurity as SmtpSecurity;
  }
  // Leer heißt unverändert, `null` heißt löschen.
  if ('smtpPass' in body && body.smtpPass !== '') {
    if (body.smtpPass !== null && typeof body.smtpPass !== 'string') {
      throw new ApiError(msg('Das SMTP-Passwort muss ein Text sein.'));
    }
    input.smtpPass = body.smtpPass;
  }
  return input;
}

/**
 * Aus einer Eingabe das, was gespeichert wird. Rein bis auf `encryptPass`, das
 * hereingereicht wird: so lässt sich jede Regel ohne Datenbank und ohne
 * Schlüssel prüfen (`tests/mail/settings.test.ts`).
 */
export function settingsPatch(
  input: SettingsInput,
  current: Pick<Settings, 'notifyEvents'> & Partial<Pick<Settings, 'autoUpdate'>>,
  encryptPass: (plaintext: string) => string
): Partial<SettingsData> {
  const patch: Partial<SettingsData> = {};

  if (input.acmeEmail !== undefined) {
    const email = input.acmeEmail?.trim() || null;
    if (email && !validateAcmeEmail(email)) throw new ApiError(msg('Die E-Mail-Adresse für Let\'s Encrypt ist ungültig.'));
    patch.acmeEmail = email;
  }
  if (input.publicUrl !== undefined) {
    const value = input.publicUrl?.trim() || null;
    patch.publicUrl = value ? normalizePublicUrl(value) : null;
  }
  // Die Liste gewinnt. Der alte Schalter nimmt HAProxy dazu oder heraus.
  if (input.autoUpdate !== undefined || input.autoUpdateHaproxy !== undefined) {
    let list: UpdateComponent[] = input.autoUpdate ?? current.autoUpdate ?? [...DEFAULT_AUTO_UPDATE];
    if (input.autoUpdate === undefined && input.autoUpdateHaproxy !== undefined) {
      list = input.autoUpdateHaproxy
        ? [...list.filter((c) => c !== 'haproxy'), 'haproxy']
        : list.filter((c) => c !== 'haproxy');
    }
    patch.autoUpdate = AUTO_UPDATE_ORDER.filter((component) => list.includes(component));
    patch.autoUpdateHaproxy = patch.autoUpdate.includes('haproxy');
  }
  if (input.autoUpdateTime !== undefined) {
    if (!validateTime(input.autoUpdateTime)) throw new ApiError(msg('Die Uhrzeit hat nicht die Form HH:MM.'));
    patch.autoUpdateTime = input.autoUpdateTime;
  }

  if (input.smtpHost !== undefined) {
    const host = input.smtpHost?.trim().toLowerCase() || null;
    if (host && !validateHostname(host)) throw new ApiError(msg('Der SMTP-Server ist kein gültiger Name und keine gültige Adresse.'));
    patch.smtpHost = host;
  }
  if (input.smtpPort !== undefined) {
    if (!Number.isInteger(input.smtpPort) || input.smtpPort < 1 || input.smtpPort > 65535) {
      throw new ApiError(msg('Der SMTP-Port ist eine Zahl zwischen 1 und 65535.'));
    }
    patch.smtpPort = input.smtpPort;
  }
  if (input.smtpSecurity !== undefined) {
    if (!SMTP_SECURITIES.includes(input.smtpSecurity)) {
      throw new ApiError(msg('Die Verschlüsselung ist STARTTLS, TLS oder keine.'));
    }
    patch.smtpSecurity = input.smtpSecurity;
  }
  if (input.smtpUser !== undefined) {
    const user = input.smtpUser?.trim() || null;
    if (user && (user.length > 320 || /[\r\n]/.test(user))) throw new ApiError(msg('Der SMTP-Benutzer ist ungültig.'));
    patch.smtpUser = user;
  }
  if (input.smtpPass === null) patch.smtpPass = null;
  else if (input.smtpPass) {
    if (input.smtpPass.length > 1024) throw new ApiError(msg('Das SMTP-Passwort ist zu lang.'));
    patch.smtpPass = encryptPass(input.smtpPass);
  }
  if (input.mailFrom !== undefined) {
    const from = input.mailFrom?.trim() || null;
    if (from && !parseSender(from)) {
      throw new ApiError(msg('Der Absender ist eine E-Mail-Adresse, wahlweise mit Namen davor: HAPM <hapm@example.org>.'));
    }
    patch.mailFrom = from;
  }

  if (input.notifyRecipients !== undefined) {
    if (!Array.isArray(input.notifyRecipients)) throw new ApiError(msg('Die Empfänger sind eine Liste von Adressen.'));
    patch.notifyRecipients = normalizeRecipients(input.notifyRecipients);
  }
  if (input.notifyEvents !== undefined) {
    const next = { ...current.notifyEvents };
    for (const [type, enabled] of Object.entries(input.notifyEvents)) {
      if (!(NOTIFICATION_EVENT_TYPES as readonly string[]).includes(type)) {
        throw new ApiError(msg('Das Ereignis „{type}“ gibt es nicht.', { type }));
      }
      if (typeof enabled !== 'boolean') throw new ApiError(msg('Der Schalter eines Ereignisses kennt nur an und aus.'));
      next[type as NotificationEventType] = enabled;
    }
    patch.notifyEvents = next;
  }
  if (input.mailLocale !== undefined) {
    if (!isLocale(input.mailLocale)) throw new ApiError(msg('Die Sprache der Mails ist Deutsch oder Englisch.'));
    patch.mailLocale = input.mailLocale;
  }

  if (input.exposure !== undefined) {
    if (!EXPOSURES.includes(input.exposure)) {
      throw new ApiError(msg('Die Installation ist entweder intern oder aus dem Internet erreichbar.'));
    }
    patch.exposure = input.exposure;
  }
  if (input.certificateSource !== undefined) {
    if (!CERTIFICATE_SOURCES.includes(input.certificateSource)) {
      throw new ApiError(msg('Zertifikate kommen entweder über ACME oder werden hochgeladen.'));
    }
    patch.certificateSource = input.certificateSource;
  }
  if (input.acmeDirectory !== undefined) {
    const url = input.acmeDirectory === null ? '' : normalizeAcmeDirectory(input.acmeDirectory);
    if (url) {
      const invalid = validateAcmeDirectory(url);
      if (invalid) throw new ApiError(invalid);
    }
    patch.acmeDirectory = url || null;
  }
  if (input.acmeHttpReachable !== undefined) {
    if (typeof input.acmeHttpReachable !== 'boolean') {
      throw new ApiError(msg('Der Schalter für HTTP über Port 80 kennt nur an und aus.'));
    }
    patch.acmeHttpReachable = input.acmeHttpReachable;
  }
  if (input.setupStatus !== undefined) {
    if (!SETUP_STATUSES.includes(input.setupStatus)) throw new ApiError(msg('Unbekannter Stand der Einrichtung.'));
    patch.setupStatus = input.setupStatus;
  }

  return patch;
}

/**
 * Die Angabe zur Challenge für einen Vorgang, aus den Einstellungen. Die
 * Routen rufen das und geben das Ergebnis an `provision.ts` weiter, das selbst
 * keine Datenbank fragt.
 */
export function challengeFor(
  settings: Parameters<typeof challengeChoice>[0],
  dnsHook: string | null
): ChallengeChoice {
  return challengeChoice(settings, dnsHook, process.env.HAPM_ACME_SERVER);
}

/**
 * Ob ein Wechsel der Adresse die Passkeys entwertet: sobald sich der Host
 * ändert oder die Adresse wegfällt. Ein Passkey hängt an der Domain, nicht an
 * Schema oder Port.
 */
export function passkeysDroppedBy(
  before: Pick<Settings, 'publicUrl'>,
  after: Pick<Settings, 'publicUrl'>
): boolean {
  const was = publicHost(before);
  return was !== null && was !== publicHost(after);
}

export async function updateSettings(input: SettingsInput): Promise<Settings> {
  const current = await getSettings();
  const patch = settingsPatch(input, current, encrypt);
  await updateDocument<Settings>(COLLECTIONS.SETTINGS, SETTINGS_ID, patch);
  const next = await getSettings();
  // Hier und nicht in den Routen: jeder Weg, der die Adresse ändert (Allgemein,
  // Umzugsassistent, Einrichtung), nimmt die Passkeys mit.
  if (passkeysDroppedBy(current, next)) {
    const removed = await deleteAllPasskeys();
    if (removed > 0) console.log(`[einstellungen] Adresse geändert, ${removed} Passkey(s) gelöscht.`);
  }
  return next;
}
