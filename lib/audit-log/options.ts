/**
 * Die Auswahlmöglichkeiten der Seite „Protokoll" und ihre Grenzen.
 *
 * Rein: die Seite lädt diese Datei, `settings.ts` (Datenbank, Verschlüsselung)
 * darf sie nicht laden. Die Texte sind Schlüssel (`msgid`), die Seite zeigt
 * sie mit `t()`.
 */

import { msgid } from '../i18n/translate';

export const AUDIT_RETENTION_DEFAULT = 365;
export const AUDIT_RETENTION_MIN = 30;
export const AUDIT_RETENTION_MAX = 3650;

export const SYSLOG_PROTOCOLS = ['udp', 'tcp', 'tls'] as const;
export type SyslogProtocol = (typeof SYSLOG_PROTOCOLS)[number];

export const SYSLOG_DEFAULT_PORTS: Record<SyslogProtocol, number> = { udp: 514, tcp: 514, tls: 6514 };

export const SYSLOG_FORMATS = ['json', 'cef'] as const;
export type SyslogFormat = (typeof SYSLOG_FORMATS)[number];

export const SYSLOG_FRAMINGS = ['octet', 'newline'] as const;

export const HTTP_BODIES = ['json', 'hec'] as const;
export type HttpBody = (typeof HTTP_BODIES)[number];

export const SYSLOG_PROTOCOL_CHOICES: { value: SyslogProtocol; label: string; hint: string }[] = [
  { value: 'tls', label: 'TLS', hint: msgid('Verschlüsselt, üblich auf Port 6514.') },
  { value: 'tcp', label: 'TCP', hint: msgid('Unverschlüsselt, üblich auf Port 514.') },
  { value: 'udp', label: 'UDP', hint: msgid('Unverschlüsselt und ohne Bestätigung, üblich auf Port 514.') },
];

export const SYSLOG_FORMAT_CHOICES: { value: SyslogFormat; label: string; hint: string }[] = [
  { value: 'json', label: 'JSON', hint: msgid('Jeder Eintrag als JSON-Objekt im Text der Nachricht.') },
  { value: 'cef', label: 'CEF', hint: msgid('Common Event Format, etwa für ArcSight und QRadar.') },
];

export const SYSLOG_FRAMING_CHOICES: { value: (typeof SYSLOG_FRAMINGS)[number]; label: string; hint: string }[] = [
  { value: 'octet', label: msgid('Länge voran'), hint: msgid('RFC 6587, für rsyslog und syslog-ng.') },
  { value: 'newline', label: msgid('Zeilenende'), hint: msgid('Eine Nachricht je Zeile, etwa für Graylog und Splunk.') },
];

export const HTTP_BODY_CHOICES: { value: HttpBody; label: string; hint: string }[] = [
  { value: 'json', label: 'JSON', hint: msgid('Ein Eintrag je Anfrage, als JSON-Objekt.') },
  { value: 'hec', label: 'Splunk HEC', hint: msgid('Für den Endpunkt /services/collector/event von Splunk.') },
];
