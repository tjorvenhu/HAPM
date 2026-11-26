import { describe, expect, it } from 'vitest';
import {
  auditPayload,
  formatCef,
  formatRfc5424,
  frame,
  headerField,
  hecEvent,
  singleLine,
  syslogTimestamp,
} from '@/lib/audit-log/format';
import type { AuditEntry } from '@/lib/audit-log/read';

/**
 * Die Nachrichten an ein SIEM, Zeichen für Zeichen.
 *
 * Ein Empfänger zerlegt sie nach festen Regeln (RFC 5424, RFC 6587, CEF). Ein
 * Feld an der falschen Stelle fällt dort nicht als Fehler auf, sondern als
 * Eintrag, der unter dem falschen Namen einsortiert wird.
 */

const NEL = String.fromCharCode(0x85);
const LINE_SEPARATOR = String.fromCharCode(0x2028);

const ENTRY: AuditEntry = {
  id: '0193a0b1c2d3700080000000000000aa',
  timestamp: '2026-11-26T08:15:30.123Z',
  action: 'login_failed',
  area: 'auth',
  actorType: 'user',
  actor: 'admin@example.org',
  actorId: '',
  resource: 'user',
  resourceId: null,
  details: 'Falsches Passwort',
  ip: '203.0.113.7',
  outcome: 'failure',
};

describe('RFC 5424', () => {
  it('setzt Kopf und Text in der vorgeschriebenen Reihenfolge', () => {
    const line = formatRfc5424({
      facility: 'local0',
      severity: 4,
      timestamp: ENTRY.timestamp,
      hostname: 'proxy01',
      appName: 'hapm',
      msgId: 'login_failed',
      text: '{"a":1}',
    });
    // local0 = 16, Warnung = 4: 16 * 8 + 4.
    expect(line).toBe('<132>1 2026-11-26T08:15:30.123Z proxy01 hapm - login_failed - {"a":1}');
  });

  it('rechnet die Priorität aus Facility und Dringlichkeit', () => {
    const pri = (facility: 'auth' | 'authpriv' | 'audit' | 'local7', severity: number) =>
      formatRfc5424({ facility, severity, timestamp: ENTRY.timestamp, hostname: 'h', appName: 'a', text: 'x' }).split('>')[0];
    expect(pri('auth', 6)).toBe('<38');
    expect(pri('authpriv', 6)).toBe('<86');
    expect(pri('audit', 5)).toBe('<109');
    expect(pri('local7', 4)).toBe('<188');
  });

  it('lässt im Kopf nur druckbares ASCII ohne Leerzeichen', () => {
    expect(headerField('proxy 01', 255)).toBe('proxy_01');
    expect(headerField('prüfstand', 255)).toBe('pr_fstand');
    expect(headerField('a\nb', 255)).toBe('a_b');
    expect(headerField('', 48)).toBe('-');
    expect(headerField(null, 48)).toBe('-');
    expect(headerField('x'.repeat(60), 48)).toHaveLength(48);
  });

  it('kürzt die Kennung der Nachricht auf 32 Zeichen', () => {
    const line = formatRfc5424({
      facility: 'local0',
      severity: 6,
      timestamp: ENTRY.timestamp,
      hostname: 'h',
      appName: 'a',
      msgId: 'x'.repeat(40),
      text: 't',
    });
    expect(line.split(' ')[5]).toBe('x'.repeat(32));
  });

  it('macht aus jedem Zeilenumbruch im Text ein Leerzeichen', () => {
    const smuggled = `erste Zeile\n<34>1 2026-01-01T00:00:00Z fremd su - - - root angemeldet\r\nnoch eine${NEL}und${LINE_SEPARATOR}Schluss\u0000`;
    const line = formatRfc5424({
      facility: 'local0',
      severity: 6,
      timestamp: ENTRY.timestamp,
      hostname: 'h',
      appName: 'a',
      text: smuggled,
    });
    expect(line).not.toMatch(/[\n\r]/);
    expect(line.includes(NEL)).toBe(false);
    expect(line.includes(LINE_SEPARATOR)).toBe(false);
    expect(line.includes(String.fromCharCode(0))).toBe(false);
    expect(singleLine('a\n\nb')).toBe('a b');
  });

  it('behält Umlaute im Text', () => {
    expect(singleLine('Zurückspielen gescheitert: Schlüssel fehlt')).toBe('Zurückspielen gescheitert: Schlüssel fehlt');
  });

  it('schneidet Nanosekunden auf sechs Stellen und nimmt sonst nichts an', () => {
    expect(syslogTimestamp('2026-11-24T14:00:00.123456789Z')).toBe('2026-11-24T14:00:00.123456Z');
    expect(syslogTimestamp('2026-11-24T14:00:00Z')).toBe('2026-11-24T14:00:00Z');
    expect(syslogTimestamp('2026-11-24T14:00:00.5+01:00')).toBe('2026-11-24T14:00:00.5+01:00');
    expect(syslogTimestamp('gestern')).toBe('-');
    expect(syslogTimestamp('2026-11-24T14:00:00Z injected')).toBe('-');
  });
});

describe('Rahmung nach RFC 6587', () => {
  it('stellt die Länge in Bytes voran, nicht in Zeichen', () => {
    expect(frame('abc', 'octet').toString('utf8')).toBe('3 abc');
    // „ü" sind zwei Bytes.
    expect(frame('für', 'octet').toString('utf8')).toBe('4 für');
  });

  it('hängt sonst ein Zeilenende an', () => {
    expect(frame('abc', 'newline').toString('utf8')).toBe('abc\n');
  });

  it('lässt sich aus einem Strom wieder in Nachrichten zerlegen', () => {
    const messages = ['<134>1 a', 'für später', 'x'.repeat(300)];
    let rest = Buffer.concat(messages.map((message) => frame(message, 'octet')));
    const read: string[] = [];
    while (rest.length > 0) {
      const space = rest.indexOf(0x20);
      const length = Number(rest.subarray(0, space).toString('ascii'));
      read.push(rest.subarray(space + 1, space + 1 + length).toString('utf8'));
      rest = rest.subarray(space + 1 + length);
    }
    expect(read).toEqual(messages);
  });
});

describe('JSON', () => {
  it('trägt Herkunft und alle Felder des Eintrags', () => {
    expect(auditPayload(ENTRY, 'proxy01')).toEqual({ source: 'hapm', host: 'proxy01', ...ENTRY });
  });

  it('ist als Text eine einzige Zeile, auch mit Umbruch in den Einzelheiten', () => {
    const text = JSON.stringify(auditPayload({ ...ENTRY, details: 'eins\nzwei' }, 'h'));
    expect(text).not.toMatch(/[\n\r]/);
    expect(JSON.parse(text).details).toBe('eins\nzwei');
  });

  it('verpackt für Splunk HEC das Ereignis mit Zeit in Sekunden', () => {
    const event = hecEvent(ENTRY, 'proxy01');
    expect(event).toMatchObject({ host: 'proxy01', source: 'hapm', sourcetype: 'hapm:audit', event: ENTRY });
    expect(event.time).toBe(Date.parse(ENTRY.timestamp) / 1000);
  });
});

describe('CEF', () => {
  const context = { host: 'proxy01', version: '0.6.1', name: 'Anmeldung gescheitert' };

  it('setzt sieben Felder im Kopf und danach die Erweiterung', () => {
    const line = formatCef(ENTRY, context);
    expect(line.startsWith('CEF:0|HAPM|HAPM|0.6.1|login_failed|Anmeldung gescheitert|6|')).toBe(true);
    expect(line).toContain(`rt=${Date.parse(ENTRY.timestamp)}`);
    expect(line).toContain('suser=admin@example.org');
    expect(line).toContain('src=203.0.113.7');
    expect(line).toContain('outcome=failure');
    expect(line).toContain('cs1Label=resource cs1=user');
    expect(line).toContain('msg=Falsches Passwort');
    expect(line).toContain(`externalId=${ENTRY.id}`);
  });

  it('stuft einen Erfolg niedriger ein als einen Fehlschlag', () => {
    expect(formatCef({ ...ENTRY, action: 'login', outcome: 'success' }, context).split('|')[6]).toBe('3');
  });

  it('maskiert Trenner im Kopf und in der Erweiterung', () => {
    const line = formatCef(
      { ...ENTRY, action: 'a|b', details: 'pfad=C:\\temp\nzweite Zeile', actor: 'a=b' },
      { ...context, name: 'Name | mit \\ Strich' }
    );
    expect(line).toContain('|a\\|b|Name \\| mit \\\\ Strich|');
    expect(line).toContain('msg=pfad\\=C:\\\\temp\\nzweite Zeile');
    expect(line).toContain('suser=a\\=b');
    expect(line).not.toMatch(/[\n\r]/);
  });

  it('lässt leere Felder weg und setzt src nur für eine IP-Adresse', () => {
    const line = formatCef({ ...ENTRY, ip: 'unknown', resource: null, resourceId: null, details: null }, context);
    expect(line).not.toContain('src=');
    expect(line).not.toContain('cs1');
    expect(line).not.toContain('msg=');
    expect(formatCef({ ...ENTRY, ip: '2001:db8::1' }, context)).toContain('src=2001:db8::1');
  });
});
