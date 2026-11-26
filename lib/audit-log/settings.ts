/**
 * Die Einstellungen des Protokolls: wie lange es aufgehoben wird und wohin es
 * weitergeleitet wird (Syslog, HTTP-Endpunkt).
 *
 * Eine eigene Zeile, getrennt von den allgemeinen Einstellungen. Geändert wird
 * sie nur in der Oberfläche: über einen API-Key ließe sich sonst die
 * Aufbewahrung kürzen oder die Weiterleitung umbiegen, und genau das soll
 * jemand mit einem gestohlenen Key nicht können (docs/mcp.md, „Was es bewusst
 * nicht gibt").
 *
 * Der Wert der Kopfzeile des HTTP-Endpunkts (ein Token des SIEM) liegt
 * verschlüsselt in der Zeile (`lib/crypto.ts`). Die Oberfläche erfährt nur, ob
 * einer gesetzt ist. Ein CA-Zertifikat ist kein Geheimnis und kommt zurück.
 */

import { X509Certificate } from 'node:crypto';
import net from 'node:net';
import { getSingleton, updateDocument } from '../db';
import { ApiError } from '../api';
import { encrypt } from '../crypto';
import { msg, type Message } from '../i18n/translate';
import { COLLECTIONS, type DbDoc } from '../types';
import { SYSLOG_FACILITY_NAMES, type SyslogFacility, type SyslogFraming } from './format';
import {
  AUDIT_RETENTION_DEFAULT,
  AUDIT_RETENTION_MAX,
  AUDIT_RETENTION_MIN,
  HTTP_BODIES,
  SYSLOG_DEFAULT_PORTS,
  SYSLOG_FORMATS,
  SYSLOG_FRAMINGS,
  SYSLOG_PROTOCOLS,
  type HttpBody,
  type SyslogFormat,
  type SyslogProtocol,
} from './options';

export {
  AUDIT_RETENTION_DEFAULT,
  AUDIT_RETENTION_MAX,
  AUDIT_RETENTION_MIN,
  HTTP_BODIES,
  SYSLOG_DEFAULT_PORTS,
  SYSLOG_FORMATS,
  SYSLOG_FRAMINGS,
  SYSLOG_PROTOCOLS,
};
export type { HttpBody, SyslogFormat, SyslogProtocol };

const SETTINGS_ID = 'main';

export interface SyslogSettings {
  enabled: boolean;
  host: string | null;
  port: number;
  protocol: SyslogProtocol;
  /** Nur für TCP und TLS: wie zwei Nachrichten getrennt werden. */
  framing: SyslogFraming;
  facility: SyslogFacility;
  appName: string;
  format: SyslogFormat;
  /** PEM. Nur für TLS: die CA, die das Zertifikat des Empfängers ausgestellt hat. */
  caPem: string | null;
  /** Auch das Zugriffslog von HAProxy an dieses Ziel schicken. */
  haproxyLog: boolean;
}

export interface HttpSettings {
  enabled: boolean;
  url: string | null;
  body: HttpBody;
  headerName: string | null;
  /** Verschlüsselt (`lib/crypto.ts`). */
  headerValue: string | null;
  caPem: string | null;
}

export interface AuditSettings extends DbDoc {
  retentionDays: number;
  syslog: SyslogSettings;
  http: HttpSettings;
}

export type HttpSettingsView = Omit<HttpSettings, 'headerValue'> & { headerValueSet: boolean };

export interface AuditSettingsView {
  retentionDays: number;
  syslog: SyslogSettings;
  http: HttpSettingsView;
}

export interface AuditSettingsInput {
  retentionDays?: unknown;
  syslog?: Record<string, unknown>;
  http?: Record<string, unknown>;
}

const SYSLOG_DEFAULTS: SyslogSettings = {
  enabled: false,
  host: null,
  port: SYSLOG_DEFAULT_PORTS.tls,
  protocol: 'tls',
  framing: 'octet',
  facility: 'local0',
  appName: 'hapm',
  format: 'json',
  caPem: null,
  haproxyLog: false,
};

const HTTP_DEFAULTS: HttpSettings = {
  enabled: false,
  url: null,
  body: 'json',
  headerName: null,
  headerValue: null,
  caPem: null,
};

const DEFAULTS: Omit<AuditSettings, keyof DbDoc> = {
  retentionDays: AUDIT_RETENTION_DEFAULT,
  syslog: SYSLOG_DEFAULTS,
  http: HTTP_DEFAULTS,
};

export async function getAuditSettings(): Promise<AuditSettings> {
  const row = await getSingleton<AuditSettings>(COLLECTIONS.AUDIT_SETTINGS, SETTINGS_ID, DEFAULTS);
  return {
    ...row,
    retentionDays: row.retentionDays ?? AUDIT_RETENTION_DEFAULT,
    syslog: { ...SYSLOG_DEFAULTS, ...(row.syslog ?? {}) },
    http: { ...HTTP_DEFAULTS, ...(row.http ?? {}) },
  };
}

export function auditSettingsView(settings: AuditSettings): AuditSettingsView {
  const { headerValue, ...http } = settings.http;
  return {
    retentionDays: settings.retentionDays,
    syslog: settings.syslog,
    http: { ...http, headerValueSet: Boolean(headerValue) },
  };
}

/* ── Prüfungen, rein ── */

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$/i;

/** Ein Servername oder eine IP-Adresse, ohne Port und ohne Klammern. */
export function validHost(value: string): boolean {
  return net.isIP(value) !== 0 || HOSTNAME.test(value);
}

export function validPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

const MAX_PEM = 64 * 1024;

/**
 * Ein oder mehrere Zertifikate als PEM, oder eine Meldung. Geprüft wird, dass
 * jedes sich lesen lässt: ein kaputtes fiele sonst erst beim ersten
 * Verbindungsaufbau auf, als „unable to get issuer certificate".
 */
export function checkCaPem(input: string): { pem: string } | { error: Message } {
  const value = input.replace(/\r\n/g, '\n').trim();
  if (value.length > MAX_PEM) return { error: msg('Das CA-Zertifikat ist zu groß.') };
  if (/PRIVATE KEY/.test(value)) return { error: msg('Hier gehört nur das Zertifikat der CA hin, kein privater Schlüssel.') };
  const blocks = value.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (!blocks) return { error: msg('Das CA-Zertifikat ist kein PEM. Es beginnt mit -----BEGIN CERTIFICATE-----.') };
  const rest = blocks.reduce((text, block) => text.replace(block, ''), value).trim();
  if (rest !== '') return { error: msg('Neben den Zertifikaten steht im Feld noch anderer Text.') };
  try {
    for (const block of blocks) new X509Certificate(block);
  } catch {
    return { error: msg('Das CA-Zertifikat lässt sich nicht lesen.') };
  }
  return { pem: `${blocks.join('\n')}\n` };
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
/** Kopfzeilen, die die Anfrage selbst setzt. */
const RESERVED_HEADERS = ['host', 'content-length', 'content-type', 'transfer-encoding', 'connection'];

export function checkHeaderName(value: string): Message | null {
  if (!HEADER_NAME.test(value)) return msg('Der Name der Kopfzeile enthält Zeichen, die dort nicht vorkommen dürfen.');
  if (RESERVED_HEADERS.includes(value.toLowerCase())) {
    return msg('Die Kopfzeile {name} setzt HAPM selbst.', { name: value });
  }
  return null;
}

export function checkHeaderValue(value: string): Message | null {
  if (value.length > 2000) return msg('Der Wert der Kopfzeile ist zu lang.');
  // Ein Zeilenumbruch im Wert wäre eine zweite Kopfzeile.
  if (/[^\x20-\x7e]/.test(value)) return msg('Der Wert der Kopfzeile darf nur druckbare ASCII-Zeichen enthalten.');
  return null;
}

export function checkEndpointUrl(input: string): { url: string } | { error: Message } {
  if (input.length > 500) return { error: msg('Die Adresse des Endpunkts ist zu lang.') };
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { error: msg('Die Adresse des Endpunkts ist keine gültige URL.') };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { error: msg('Die Adresse des Endpunkts beginnt mit https:// oder http://.') };
  }
  if (parsed.username || parsed.password) {
    return { error: msg('Zugangsdaten gehören nicht in die Adresse, sondern in die Kopfzeile.') };
  }
  parsed.hash = '';
  return { url: parsed.toString() };
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new ApiError(msg('{field} ist wahr oder falsch.', { field }));
  return value;
}

function choice<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ApiError(msg('{field} hat einen Wert, den es nicht gibt.', { field }));
  }
  return value as T;
}

function optionalText(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new ApiError(msg('{field} ist ein Text.', { field }));
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function caPem(value: unknown): string | null {
  const text = optionalText(value, 'caPem');
  if (text === null) return null;
  const checked = checkCaPem(text);
  if ('error' in checked) throw new ApiError(checked.error);
  return checked.pem;
}

export function mergeSyslog(current: SyslogSettings, input: Record<string, unknown>): SyslogSettings {
  const next: SyslogSettings = { ...current };
  if (input.protocol !== undefined) next.protocol = choice(input.protocol, SYSLOG_PROTOCOLS, 'protocol');
  if (input.framing !== undefined) next.framing = choice(input.framing, SYSLOG_FRAMINGS, 'framing');
  if (input.facility !== undefined) next.facility = choice(input.facility, SYSLOG_FACILITY_NAMES, 'facility');
  if (input.format !== undefined) next.format = choice(input.format, SYSLOG_FORMATS, 'format');
  if (input.host !== undefined) {
    const host = optionalText(input.host, 'host');
    if (host !== null && !validHost(host)) {
      throw new ApiError(msg('Der Syslog-Server ist ein Servername oder eine IP-Adresse, ohne Port.'));
    }
    next.host = host;
  }
  if (input.port !== undefined) {
    const port = Number(input.port);
    if (!validPort(port)) throw new ApiError(msg('Der Port ist eine Zahl zwischen 1 und 65535.'));
    next.port = port;
  }
  if (input.appName !== undefined) {
    const appName = optionalText(input.appName, 'appName') ?? SYSLOG_DEFAULTS.appName;
    if (!/^[\x21-\x7e]{1,48}$/.test(appName)) {
      throw new ApiError(msg('Der Name der Anwendung hat höchstens 48 Zeichen, ohne Leerzeichen und Umlaute.'));
    }
    next.appName = appName;
  }
  if (input.caPem !== undefined) next.caPem = caPem(input.caPem);
  if (input.haproxyLog !== undefined) next.haproxyLog = bool(input.haproxyLog, 'haproxyLog');
  if (input.enabled !== undefined) next.enabled = bool(input.enabled, 'enabled');

  if (next.enabled && !next.host) {
    throw new ApiError(msg('Ohne Syslog-Server lässt sich die Weiterleitung nicht einschalten.'));
  }
  return next;
}

export function mergeHttp(current: HttpSettings, input: Record<string, unknown>): HttpSettings {
  const next: HttpSettings = { ...current };
  if (input.body !== undefined) next.body = choice(input.body, HTTP_BODIES, 'body');
  if (input.url !== undefined) {
    const url = optionalText(input.url, 'url');
    if (url === null) next.url = null;
    else {
      const checked = checkEndpointUrl(url);
      if ('error' in checked) throw new ApiError(checked.error);
      next.url = checked.url;
    }
  }
  if (input.headerName !== undefined) {
    const name = optionalText(input.headerName, 'headerName');
    if (name !== null) {
      const problem = checkHeaderName(name);
      if (problem) throw new ApiError(problem);
    }
    next.headerName = name;
  }
  // Fehlt der Wert, bleibt der gespeicherte. `null` entfernt ihn.
  if (input.headerValue !== undefined) {
    if (input.headerValue === null || input.headerValue === '') next.headerValue = null;
    else {
      if (typeof input.headerValue !== 'string') throw new ApiError(msg('{field} ist ein Text.', { field: 'headerValue' }));
      const problem = checkHeaderValue(input.headerValue);
      if (problem) throw new ApiError(problem);
      next.headerValue = encrypt(input.headerValue);
    }
  }
  if (input.caPem !== undefined) next.caPem = caPem(input.caPem);
  if (input.enabled !== undefined) next.enabled = bool(input.enabled, 'enabled');

  if (next.headerValue && !next.headerName) {
    throw new ApiError(msg('Zum Wert der Kopfzeile fehlt ihr Name, etwa Authorization.'));
  }
  if (next.enabled && !next.url) {
    throw new ApiError(msg('Ohne Adresse des Endpunkts lässt sich die Weiterleitung nicht einschalten.'));
  }
  return next;
}

export function readRetention(value: unknown): number {
  const days = Number(value);
  if (!Number.isInteger(days) || days < AUDIT_RETENTION_MIN || days > AUDIT_RETENTION_MAX) {
    throw new ApiError(
      msg('Das Protokoll wird zwischen {min} und {max} Tagen aufgehoben.', {
        min: AUDIT_RETENTION_MIN,
        max: AUDIT_RETENTION_MAX,
      })
    );
  }
  return days;
}

/** Schreibt die geprüfte Zeile. Protokoll und Nachlauf: `changeAuditSettings` in `actions.ts`. */
export async function saveAuditSettings(next: Pick<AuditSettings, 'retentionDays' | 'syslog' | 'http'>): Promise<AuditSettings> {
  await getAuditSettings();
  await updateDocument<AuditSettings>(COLLECTIONS.AUDIT_SETTINGS, SETTINGS_ID, next);
  return getAuditSettings();
}
