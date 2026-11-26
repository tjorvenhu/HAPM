/**
 * Ein Eintrag des Protokolls als Nachricht für ein SIEM: Syslog nach RFC 5424,
 * darin JSON oder CEF, und der Rumpf für einen HTTP-Endpunkt.
 *
 * Rein, ohne Netz und ohne Datenbank: `tests/audit-log/format.test.ts` rechnet
 * jede Form nach. Verschickt wird in `transport.ts`.
 *
 * ── Was in einer Syslog-Nachricht nicht stehen darf ──
 *
 * Ein Zeilenumbruch in einem Feld wäre bei einem Empfänger, der Nachrichten am
 * Zeilenende trennt, der Anfang einer zweiten, frei gewählten Nachricht. In
 * `details` steht Text, den auch ein Aufrufer der API mitbestimmt (der Name
 * eines Ziels, eine Fehlermeldung). Deshalb: der Kopf nimmt nur druckbares
 * ASCII, und im Text wird jedes Steuerzeichen zu einem Leerzeichen. JSON
 * maskiert Steuerzeichen ohnehin, die Regel greift dort nur als zweites Netz.
 *
 * ── Keine strukturierten Daten im Kopf ──
 *
 * RFC 5424 verlangt für eigene SD-Elemente eine bei der IANA eingetragene
 * Nummer (`name@nummer`), und HAPM hat keine. Die Felder stehen deshalb als
 * JSON oder CEF im Text, was jedes SIEM zerlegen kann.
 */

import type { AuditEntry } from './read';

/** Die Facilities, die zur Wahl stehen, mit ihrem Wert nach RFC 5424. */
export const SYSLOG_FACILITIES = {
  auth: 4,
  authpriv: 10,
  daemon: 3,
  audit: 13,
  local0: 16,
  local1: 17,
  local2: 18,
  local3: 19,
  local4: 20,
  local5: 21,
  local6: 22,
  local7: 23,
} as const;

export type SyslogFacility = keyof typeof SYSLOG_FACILITIES;

export const SYSLOG_FACILITY_NAMES = Object.keys(SYSLOG_FACILITIES) as SyslogFacility[];

export const SEVERITY = { warning: 4, notice: 5, info: 6 } as const;

export interface SyslogMessage {
  facility: SyslogFacility;
  severity: number;
  /** ISO 8601. Mehr als sechs Nachkommastellen werden abgeschnitten. */
  timestamp: string;
  hostname: string;
  appName: string;
  /** Der Name der Handlung, höchstens 32 Zeichen. */
  msgId?: string;
  text: string;
}

/** Druckbares ASCII ohne Leerzeichen, wie RFC 5424 es für die Felder des Kopfs verlangt. */
export function headerField(value: string | undefined | null, max: number): string {
  const cleaned = (value ?? '').replace(/[^\x21-\x7e]/g, '_').slice(0, max);
  return cleaned === '' ? '-' : cleaned;
}

/**
 * Steuerzeichen und die Zeilentrenner jenseits von ASCII (NEL, U+2028, U+2029).
 * Aus Zeichennummern gebaut: im Quelltext stünden sie sonst als die Zeichen
 * selbst, und zwei davon beenden für JavaScript eine Zeile.
 */
const CONTROL_RUN = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f, 0x85, 0x2028, 0x2029)}]+`,
  'g'
);

/** Jedes Steuerzeichen wird ein Leerzeichen: eine Nachricht bleibt eine Zeile. */
export function singleLine(text: string): string {
  return text.replace(CONTROL_RUN, ' ');
}

/** RFC 3339 mit höchstens sechs Nachkommastellen. Docker liefert neun. */
export function syslogTimestamp(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return '-';
  const fraction = match[2] ? `.${match[2].slice(0, 6)}` : '';
  return `${match[1]}${fraction}${match[3]}`;
}

/** `<PRI>1 ZEIT HOST APP PROCID MSGID - TEXT` */
export function formatRfc5424(message: SyslogMessage): string {
  const priority = SYSLOG_FACILITIES[message.facility] * 8 + message.severity;
  return [
    `<${priority}>1`,
    syslogTimestamp(message.timestamp),
    headerField(message.hostname, 255),
    headerField(message.appName, 48),
    '-',
    headerField(message.msgId, 32),
    '-',
    singleLine(message.text),
  ].join(' ');
}

export type SyslogFraming = 'octet' | 'newline';

/**
 * Die Grenze zwischen zwei Nachrichten auf einem Strom (RFC 6587).
 * `octet`: die Länge in Bytes steht davor. `newline`: ein Zeilenende dahinter,
 * für Empfänger, die nur das können. Über UDP ist ein Datagramm eine Nachricht.
 */
export function frame(message: string, framing: SyslogFraming): Buffer {
  const body = Buffer.from(message, 'utf8');
  if (framing === 'newline') return Buffer.concat([body, Buffer.from('\n')]);
  return Buffer.concat([Buffer.from(`${body.length} `, 'ascii'), body]);
}

/** Der Eintrag als JSON-Objekt, mit Herkunft: das steht in einem Webhook sonst nirgends. */
export function auditPayload(entry: AuditEntry, host: string): Record<string, unknown> {
  return { source: 'hapm', host, ...entry };
}

function cefHeader(value: string): string {
  return singleLine(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

function cefValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/=/g, '\\=')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(CONTROL_RUN, ' ');
}

function isIp(value: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(value) || (/^[0-9a-fA-F:.]+$/.test(value) && value.includes(':'));
}

/**
 * ArcSight Common Event Format, Fassung 0.
 *
 * `name` ist der Text der Handlung auf Deutsch, wie `details`: das Protokoll
 * ist eine Aufzeichnung und steht in einer Sprache (docs/i18n.md). Woran ein
 * SIEM eine Regel hängt, ist die Kennung der Signatur, der Name der Handlung.
 */
export function formatCef(entry: AuditEntry, context: { host: string; version: string; name: string }): string {
  const header = [
    'CEF:0',
    'HAPM',
    'HAPM',
    cefHeader(context.version),
    cefHeader(entry.action),
    cefHeader(context.name),
    entry.outcome === 'failure' ? '6' : '3',
  ].join('|');

  const extension: [string, string | null][] = [
    ['rt', String(Date.parse(entry.timestamp))],
    ['dvchost', context.host],
    ['externalId', entry.id],
    ['act', entry.action],
    ['outcome', entry.outcome],
    ['suser', entry.actor || null],
    ['suid', entry.actorId || null],
    ['src', entry.ip && isIp(entry.ip) ? entry.ip : null],
    ['cat', entry.area],
    ['cs1Label', entry.resource ? 'resource' : null],
    ['cs1', entry.resource],
    ['cs2Label', entry.resourceId ? 'resourceId' : null],
    ['cs2', entry.resourceId],
    ['cs3Label', 'actorType'],
    ['cs3', entry.actorType],
    ['msg', entry.details],
  ];

  const fields = extension
    .filter((pair): pair is [string, string] => pair[1] !== null && pair[1] !== '')
    .map(([key, value]) => `${key}=${cefValue(value)}`);
  return `${header}|${fields.join(' ')}`;
}

/** Der Rumpf für Splunk HEC (`/services/collector/event`): ein Ereignis je Objekt. */
export function hecEvent(entry: AuditEntry, host: string): Record<string, unknown> {
  return {
    time: Date.parse(entry.timestamp) / 1000,
    host,
    source: 'hapm',
    sourcetype: 'hapm:audit',
    event: entry,
  };
}
