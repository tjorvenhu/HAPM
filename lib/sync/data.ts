/**
 * Der Datenteil eines Pakets: was nicht in einer Datei steht und trotzdem auf
 * beiden Knoten gleich sein soll. Konten, Einstellungen, DNS-Zonen, API-Keys
 * und von CrowdSec die Sperren von Hand, die Freigaben und die Regeln.
 *
 * ── Geheimnisse im Klartext ──
 *
 * Was in der Datenbank verschlüsselt liegt (TOTP-Geheimnis, Zugang einer Zone,
 * SMTP-Passwort), ist dort mit dem `encryptionKey` des Knotens verschlüsselt,
 * und der ist auf jedem Knoten ein anderer. Der Hauptknoten entschlüsselt
 * deshalb vor dem Packen, der Folgeknoten verschlüsselt mit seinem eigenen
 * Schlüssel neu. Auf der Leitung schützt der Umschlag (`envelope.ts`), wie die
 * privaten Schlüssel der Zertifikate im selben Paket. `null` an der Stelle
 * eines Geheimnisses heißt: es ließ sich auf dem Hauptknoten nicht lesen.
 *
 * ── Was je Knoten bleibt ──
 *
 * Sitzungen, letzte Anmeldung und Sprache eines Kontos, der Zähler eines
 * Passkeys, wann ein API-Key zuletzt benutzt wurde, der Zustand einer Zone
 * beim Anbieter. Von den Einstellungen die selbsttätigen Updates (zwei Knoten
 * sollen nicht in derselben Minute neu starten) und der Stand der Einrichtung.
 * Von CrowdSec die Sperren, die es selbst verhängt hat, und seine Ereignisse.
 *
 * ── Zwei Fingerabdrücke ──
 *
 * Einer über alles aus der Datenbank, einer über CrowdSec. Getrennt, weil sich
 * CrowdSec nicht immer lesen lässt (es startet nach jeder Änderung an den
 * Regeln neu): dann fehlt dieser Teil im Paket, und der Folgeknoten behält,
 * was er hat, statt dass ein halber Stand als neuer gilt.
 *
 * Rein: keine Datenbank, kein CrowdSec. `tests/sync/data.test.ts` rechnet
 * jede Regel nach.
 */

import { createHash } from 'node:crypto';
import type { Settings } from '../types';

/* ── Konten ── */

export interface SyncUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: string;
}

/** Der Zugang eines Kontos (`auth_accounts`). `password` ist der Hash, wie Better-Auth ihn ablegt. */
export interface SyncAccount {
  id: string;
  accountId: string;
  providerId: string;
  userId: string;
  password: string | null;
  createdAt: string;
}

export interface SyncPasskey {
  id: string;
  name: string | null;
  publicKey: string;
  userId: string;
  credentialId: string;
  /** Geht mit, zählt aber nicht zum Fingerabdruck: jede Anmeldung erhöht ihn. */
  counter: number;
  deviceType: string;
  backedUp: boolean;
  transports: string | null;
  createdAt: string | null;
  aaguid: string | null;
}

export interface SyncTwoFactor {
  userId: string;
  /** Im Klartext. `null`: auf dem Hauptknoten nicht lesbar, das Konto ist dort wie hier ausgesperrt. */
  secret: string | null;
  enabled: boolean;
  /**
   * Die Hashes der Wiederherstellungscodes. Sie hängen am Schlüssel des
   * Knotens, auf dem sie entstanden, und gelten nur dort.
   */
  recoveryCodes: string[];
  recoveryCodesCreatedAt: string | null;
}

export interface SyncAccounts {
  users: SyncUser[];
  accounts: SyncAccount[];
  passkeys: SyncPasskey[];
  twoFactor: SyncTwoFactor[];
}

/* ── Einstellungen ── */

/**
 * Die Einstellungen, die auf jedem Knoten gleich sind. Was hier fehlt, stellt
 * jeder Knoten für sich ein (`autoUpdate`, `autoUpdateTime`, `setupStatus`).
 */
export const SYNCED_SETTINGS = [
  'acmeEmail',
  'publicUrl',
  'smtpHost',
  'smtpPort',
  'smtpSecurity',
  'smtpUser',
  'mailFrom',
  'notifyRecipients',
  'notifyEvents',
  'mailLocale',
  'exposure',
  'certificateSource',
  'acmeDirectory',
  'acmeHttpReachable',
  'dnsWait',
] as const satisfies readonly (keyof Settings)[];

export type SyncedSettingKey = (typeof SYNCED_SETTINGS)[number];

export type SyncSettingsData = Pick<Settings, SyncedSettingKey> & {
  /** Im Klartext, `null`: keines gesetzt oder auf dem Hauptknoten nicht lesbar. */
  smtpPass: string | null;
};

/* ── DNS-Zonen und API-Keys ── */

export interface SyncDnsZone {
  id: string;
  provider: string | null;
  name: string;
  zoneId: string;
  /** Der Zugang im Klartext. `null`: auf dem Hauptknoten nicht lesbar. */
  access: string | null;
}

export interface SyncServiceToken {
  id: string;
  name: string;
  tokenHash: string;
  prefix: string;
  description: string | null;
  createdBy: string | null;
  revokedAt: string | null;
  scopes: string | null;
  areas: string | null;
  allowedIps: string | null;
}

/* ── CrowdSec ── */

export interface SyncBan {
  value: string;
  scope: 'ip' | 'range';
  reason: string;
  /** Wann sie verhängt wurde. Daran erkennt der Fingerabdruck eine Sperre wieder. */
  createdAt: string | null;
  until: string;
}

export interface SyncAllow {
  value: string;
  description: string;
  /** `null`: unbefristet. */
  expiresAt: string | null;
}

export interface SyncCrowdsec {
  /** Nur Sperren von Hand. Was CrowdSec selbst verhängt, verhängt es auf jedem Knoten selbst. */
  bans: SyncBan[];
  allowlist: SyncAllow[];
  /** `off` oder `block`, siehe `lib/crowdsec/files.ts`. */
  crs: string;
  /** Die eingeschalteten Sammlungen aus `OPTIONAL_COLLECTIONS`. */
  collections: string[];
}

export interface SyncData {
  accounts: SyncAccounts;
  settings: SyncSettingsData;
  dnsZones: SyncDnsZone[];
  serviceTokens: SyncServiceToken[];
  /** `null`: CrowdSec gibt es auf dem Hauptknoten nicht, oder es antwortete beim Packen nicht. */
  crowdsec: SyncCrowdsec | null;
}

/* ── Fingerabdruck ── */

/** JSON mit sortierten Schlüsseln: dieselben Daten ergeben denselben Text, gleich in welcher Reihenfolge sie gelesen wurden. */
export function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function sorted<T>(rows: readonly T[], key: (row: T) => string): T[] {
  return [...rows].sort((a, b) => {
    const left = key(a);
    const right = key(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/**
 * Der Fingerabdruck dessen, was aus der Datenbank kommt. Der Zähler eines
 * Passkeys gehört nicht dazu: er steigt mit jeder Anmeldung, auf jedem Knoten
 * für sich.
 */
export function dataFingerprint(data: Pick<SyncData, 'accounts' | 'settings' | 'dnsZones' | 'serviceTokens'>): string {
  return digest({
    users: sorted(data.accounts.users, (row) => row.id),
    accounts: sorted(data.accounts.accounts, (row) => row.id),
    passkeys: sorted(data.accounts.passkeys, (row) => row.id).map(({ counter: _counter, ...rest }) => {
      void _counter;
      return rest;
    }),
    twoFactor: sorted(data.accounts.twoFactor, (row) => row.userId).map((row) => ({ ...row, recoveryCodes: [...row.recoveryCodes].sort() })),
    settings: { ...data.settings, notifyRecipients: [...data.settings.notifyRecipients] },
    dnsZones: sorted(data.dnsZones, (row) => row.id),
    serviceTokens: sorted(data.serviceTokens, (row) => row.id),
  });
}

/**
 * Der Fingerabdruck von CrowdSec. Von einer Sperre zählen Adresse und
 * Zeitpunkt, nicht das Ende: das rechnet HAPM aus der Restdauer, die `cscli`
 * nennt, und die schwankt von Aufruf zu Aufruf um Bruchteile einer Sekunde.
 */
export function crowdsecFingerprint(crowdsec: SyncCrowdsec): string {
  return digest({
    bans: sorted(crowdsec.bans, (ban) => `${ban.value}\0${ban.createdAt ?? ''}`).map((ban) => ({
      value: ban.value,
      createdAt: ban.createdAt,
      reason: ban.reason,
    })),
    allowlist: sorted(crowdsec.allowlist, (entry) => entry.value),
    crs: crowdsec.crs,
    collections: [...crowdsec.collections].sort(),
  });
}

/* ── Prüfen, was ankommt ── */

export class SyncDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncDataError';
  }
}

function fail(message: string): never {
  throw new SyncDataError(message);
}

const MAX_ROWS = 5000;
const MAX_TEXT = 64 * 1024;

type Row = Record<string, unknown>;

function rows(value: unknown, what: string): Row[] {
  if (!Array.isArray(value)) fail(`Im Datenteil fehlen ${what}.`);
  if (value.length > MAX_ROWS) fail(`Der Datenteil nennt zu viele ${what}.`);
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail(`Im Datenteil stehen ${what} in einer unbekannten Form.`);
  }
  return value as Row[];
}

function text(row: Row, field: string, what: string, max = MAX_TEXT): string {
  const value = row[field];
  if (typeof value !== 'string' || value.length === 0 || value.length > max) fail(`${what}: das Feld ${field} fehlt oder ist zu lang.`);
  return value;
}

function textOrNull(row: Row, field: string, what: string, max = MAX_TEXT): string | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > max) fail(`${what}: das Feld ${field} hat nicht die erwartete Form.`);
  return value;
}

function flag(row: Row, field: string, what: string): boolean {
  if (typeof row[field] !== 'boolean') fail(`${what}: das Feld ${field} kennt nur an und aus.`);
  return row[field] as boolean;
}

function unique(values: readonly string[], what: string): void {
  if (new Set(values).size !== values.length) fail(`Im Datenteil stehen ${what} doppelt.`);
}

function parseAccounts(value: unknown): SyncAccounts {
  if (!value || typeof value !== 'object') fail('Im Datenteil fehlen die Konten.');
  const raw = value as Row;

  const users: SyncUser[] = rows(raw.users, 'Konten').map((row) => ({
    id: text(row, 'id', 'Konto', 200),
    name: typeof row.name === 'string' ? row.name.slice(0, 200) : '',
    email: text(row, 'email', 'Konto', 320),
    emailVerified: row.emailVerified === true,
    image: textOrNull(row, 'image', 'Konto'),
    createdAt: text(row, 'createdAt', 'Konto', 64),
  }));
  // Ein Paket ohne Konto sperrte den Folgeknoten zu: dort käme niemand mehr hinein.
  if (users.length === 0) fail('Der Datenteil nennt kein Konto. Ein Knoten ohne Konto ließe sich nicht mehr bedienen.');
  unique(users.map((user) => user.id), 'Konten');
  unique(users.map((user) => user.email.toLowerCase()), 'E-Mail-Adressen');
  const known = new Set(users.map((user) => user.id));
  const owned = (row: Row, what: string): string => {
    const userId = text(row, 'userId', what, 200);
    if (!known.has(userId)) fail(`${what}: das Konto dazu steht nicht im Datenteil.`);
    return userId;
  };

  const accounts: SyncAccount[] = rows(raw.accounts, 'Zugänge').map((row) => ({
    id: text(row, 'id', 'Zugang', 200),
    accountId: text(row, 'accountId', 'Zugang', 320),
    providerId: text(row, 'providerId', 'Zugang', 100),
    userId: owned(row, 'Zugang'),
    password: textOrNull(row, 'password', 'Zugang', 2000),
    createdAt: text(row, 'createdAt', 'Zugang', 64),
  }));
  unique(accounts.map((account) => account.id), 'Zugänge');
  if (!accounts.some((account) => account.providerId === 'credential' && account.password)) {
    fail('Der Datenteil nennt kein Konto mit Passwort. Am Folgeknoten könnte sich niemand mehr anmelden.');
  }

  const passkeys: SyncPasskey[] = rows(raw.passkeys, 'Passkeys').map((row) => ({
    id: text(row, 'id', 'Passkey', 200),
    name: textOrNull(row, 'name', 'Passkey', 200),
    publicKey: text(row, 'publicKey', 'Passkey'),
    userId: owned(row, 'Passkey'),
    credentialId: text(row, 'credentialId', 'Passkey', 2000),
    counter: Number.isSafeInteger(row.counter) && (row.counter as number) >= 0 ? (row.counter as number) : 0,
    deviceType: text(row, 'deviceType', 'Passkey', 100),
    backedUp: flag(row, 'backedUp', 'Passkey'),
    transports: textOrNull(row, 'transports', 'Passkey', 500),
    createdAt: textOrNull(row, 'createdAt', 'Passkey', 64),
    aaguid: textOrNull(row, 'aaguid', 'Passkey', 200),
  }));
  unique(passkeys.map((passkey) => passkey.id), 'Passkeys');
  unique(passkeys.map((passkey) => passkey.credentialId), 'Passkeys');

  const twoFactor: SyncTwoFactor[] = rows(raw.twoFactor, 'zweite Faktoren').map((row) => {
    const codes = row.recoveryCodes;
    if (!Array.isArray(codes) || codes.length > 100 || codes.some((code) => typeof code !== 'string' || code.length > 200)) {
      fail('Zweiter Faktor: die Wiederherstellungscodes haben nicht die erwartete Form.');
    }
    return {
      userId: owned(row, 'Zweiter Faktor'),
      secret: textOrNull(row, 'secret', 'Zweiter Faktor', 500),
      enabled: flag(row, 'enabled', 'Zweiter Faktor'),
      recoveryCodes: codes as string[],
      recoveryCodesCreatedAt: textOrNull(row, 'recoveryCodesCreatedAt', 'Zweiter Faktor', 64),
    };
  });
  unique(twoFactor.map((row) => row.userId), 'zweite Faktoren');

  return { users, accounts, passkeys, twoFactor };
}

function parseSettings(value: unknown): SyncSettingsData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Im Datenteil fehlen die Einstellungen.');
  const raw = value as Row;
  const out: Row = {};
  for (const key of SYNCED_SETTINGS) {
    if (!(key in raw)) fail(`Im Datenteil fehlt die Einstellung ${key}.`);
    out[key] = raw[key];
  }
  const recipients = raw.notifyRecipients;
  if (!Array.isArray(recipients) || recipients.some((entry) => typeof entry !== 'string')) {
    fail('Die Empfänger der Benachrichtigungen haben nicht die erwartete Form.');
  }
  const events = raw.notifyEvents;
  if (!events || typeof events !== 'object' || Array.isArray(events) || Object.values(events).some((entry) => typeof entry !== 'boolean')) {
    fail('Die Schalter der Benachrichtigungen haben nicht die erwartete Form.');
  }
  if (typeof raw.smtpPort !== 'number' || typeof raw.dnsWait !== 'number' || typeof raw.acmeHttpReachable !== 'boolean') {
    fail('Die Einstellungen haben nicht die erwartete Form.');
  }
  for (const key of ['smtpSecurity', 'mailLocale', 'exposure', 'certificateSource'] as const) {
    if (typeof raw[key] !== 'string') fail(`Die Einstellung ${key} hat nicht die erwartete Form.`);
  }
  for (const key of ['acmeEmail', 'publicUrl', 'smtpHost', 'smtpUser', 'mailFrom', 'acmeDirectory'] as const) {
    if (raw[key] !== null && typeof raw[key] !== 'string') fail(`Die Einstellung ${key} hat nicht die erwartete Form.`);
  }
  return { ...(out as Pick<Settings, SyncedSettingKey>), smtpPass: textOrNull(raw, 'smtpPass', 'Einstellungen', 2000) };
}

function parseCrowdsec(value: unknown): SyncCrowdsec | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) fail('Der Teil für CrowdSec hat nicht die erwartete Form.');
  const raw = value as Row;
  const bans: SyncBan[] = rows(raw.bans, 'Sperren').map((row) => {
    const scope = row.scope;
    if (scope !== 'ip' && scope !== 'range') fail('Sperre: weder Adresse noch Netz.');
    return {
      value: text(row, 'value', 'Sperre', 64),
      scope,
      reason: typeof row.reason === 'string' ? row.reason.slice(0, 200) : '',
      createdAt: textOrNull(row, 'createdAt', 'Sperre', 64),
      until: text(row, 'until', 'Sperre', 64),
    };
  });
  const allowlist: SyncAllow[] = rows(raw.allowlist, 'Freigaben').map((row) => ({
    value: text(row, 'value', 'Freigabe', 64),
    description: typeof row.description === 'string' ? row.description.slice(0, 200) : '',
    expiresAt: textOrNull(row, 'expiresAt', 'Freigabe', 64),
  }));
  unique(allowlist.map((entry) => entry.value), 'Freigaben');
  const collections = raw.collections;
  if (!Array.isArray(collections) || collections.length > 200 || collections.some((name) => typeof name !== 'string' || name.length > 200)) {
    fail('Die Sammlungen von CrowdSec haben nicht die erwartete Form.');
  }
  return { bans, allowlist, crs: text(raw, 'crs', 'CrowdSec', 20), collections: collections as string[] };
}

/**
 * Den Datenteil eines Pakets lesen und jede Angabe prüfen. Wirft
 * `SyncDataError` mit dem Grund. Unbekannte Felder fallen weg: was in die
 * Datenbank geht, steht in den Typen oben.
 */
export function parseSyncData(value: unknown): SyncData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Der Datenteil des Pakets hat nicht die erwartete Form.');
  const raw = value as Row;

  const dnsZones: SyncDnsZone[] = rows(raw.dnsZones, 'DNS-Zonen').map((row) => ({
    id: text(row, 'id', 'DNS-Zone', 200),
    provider: textOrNull(row, 'provider', 'DNS-Zone', 50),
    name: text(row, 'name', 'DNS-Zone', 255),
    zoneId: text(row, 'zoneId', 'DNS-Zone', 500),
    access: textOrNull(row, 'access', 'DNS-Zone'),
  }));
  unique(dnsZones.map((zone) => zone.id), 'DNS-Zonen');
  unique(dnsZones.map((zone) => zone.name), 'DNS-Zonen');

  const serviceTokens: SyncServiceToken[] = rows(raw.serviceTokens, 'API-Keys').map((row) => {
    const tokenHash = text(row, 'tokenHash', 'API-Key', 64);
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) fail('API-Key: der Hash hat nicht die erwartete Form.');
    return {
      id: text(row, 'id', 'API-Key', 200),
      name: text(row, 'name', 'API-Key', 200),
      tokenHash,
      prefix: text(row, 'prefix', 'API-Key', 40),
      description: textOrNull(row, 'description', 'API-Key', 2000),
      createdBy: textOrNull(row, 'createdBy', 'API-Key', 320),
      revokedAt: textOrNull(row, 'revokedAt', 'API-Key', 64),
      scopes: textOrNull(row, 'scopes', 'API-Key', 2000),
      areas: textOrNull(row, 'areas', 'API-Key', 2000),
      allowedIps: textOrNull(row, 'allowedIps', 'API-Key', 8000),
    };
  });
  unique(serviceTokens.map((token) => token.id), 'API-Keys');
  unique(serviceTokens.map((token) => token.tokenHash), 'API-Keys');

  return {
    accounts: parseAccounts(raw.accounts),
    settings: parseSettings(raw.settings),
    dnsZones,
    serviceTokens,
    crowdsec: parseCrowdsec(raw.crowdsec),
  };
}

/* ── CrowdSec auf dem Folgeknoten: was zu tun ist ── */

/** So weit dürfen zwei Enden auseinanderliegen, bevor eine Sperre oder Freigabe neu gesetzt wird. */
const DRIFT_MS = 10 * 60_000;
/** Was in weniger als einer Minute abläuft, wird nicht mehr gesetzt. */
const MIN_LEFT_MS = 60_000;

export interface LocalBan {
  id: number;
  value: string;
  until: string | null;
}

export interface BanPlan {
  /** Kennungen der Sperren, die hier aufgehoben werden. */
  remove: number[];
  add: { value: string; scope: 'ip' | 'range'; reason: string; seconds: number }[];
}

/**
 * Welche Sperren von Hand ein Folgeknoten aufhebt und welche er setzt, damit
 * seine zu denen des Hauptknotens passen. `local` sind nur seine Sperren von
 * Hand: was sein CrowdSec selbst verhängt hat, bleibt.
 */
export function planBans(wanted: readonly SyncBan[], local: readonly LocalBan[], now: number): BanPlan {
  // Je Adresse die längste: zwei Sperren derselben Adresse sind eine.
  const target = new Map<string, SyncBan>();
  for (const ban of wanted) {
    const end = Date.parse(ban.until);
    if (!Number.isFinite(end) || end - now < MIN_LEFT_MS) continue;
    const known = target.get(ban.value);
    if (!known || Date.parse(known.until) < end) target.set(ban.value, ban);
  }

  const plan: BanPlan = { remove: [], add: [] };
  const byValue = new Map<string, LocalBan[]>();
  for (const ban of local) byValue.set(ban.value, [...(byValue.get(ban.value) ?? []), ban]);

  for (const [value, here] of byValue) {
    const want = target.get(value);
    if (!want) {
      plan.remove.push(...here.map((ban) => ban.id));
      continue;
    }
    const end = Date.parse(want.until);
    const longest = Math.max(...here.map((ban) => (ban.until ? Date.parse(ban.until) : 0)));
    if (Math.abs(longest - end) <= DRIFT_MS) {
      target.delete(value);
      continue;
    }
    plan.remove.push(...here.map((ban) => ban.id));
  }
  for (const ban of target.values()) {
    plan.add.push({ value: ban.value, scope: ban.scope, reason: ban.reason, seconds: Math.floor((Date.parse(ban.until) - now) / 1000) });
  }
  return plan;
}

export interface AllowPlan {
  remove: string[];
  /** `seconds: null`: unbefristet. */
  add: { value: string; description: string; seconds: number | null }[];
}

/** Dasselbe für die Freigaben: weg, was der Hauptknoten nicht nennt, neu, was fehlt oder anders endet. */
export function planAllowlist(wanted: readonly SyncAllow[], local: readonly SyncAllow[], now: number): AllowPlan {
  const plan: AllowPlan = { remove: [], add: [] };
  const target = new Map<string, SyncAllow>();
  for (const entry of wanted) {
    if (entry.expiresAt !== null) {
      const end = Date.parse(entry.expiresAt);
      if (!Number.isFinite(end) || end - now < MIN_LEFT_MS) continue;
    }
    target.set(entry.value, entry);
  }
  for (const here of local) {
    const want = target.get(here.value);
    const same =
      want !== undefined &&
      want.description === here.description &&
      (want.expiresAt === null
        ? here.expiresAt === null
        : here.expiresAt !== null && Math.abs(Date.parse(want.expiresAt) - Date.parse(here.expiresAt)) <= DRIFT_MS);
    if (same) target.delete(here.value);
    else plan.remove.push(here.value);
  }
  for (const entry of target.values()) {
    plan.add.push({
      value: entry.value,
      description: entry.description,
      seconds: entry.expiresAt === null ? null : Math.floor((Date.parse(entry.expiresAt) - now) / 1000),
    });
  }
  return plan;
}
