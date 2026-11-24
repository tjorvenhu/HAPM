import { describe, expect, it } from 'vitest';
import { isNewerVersion, parseAcmeVersion } from '@/lib/acme';
import { formatLogLine } from '@/lib/haproxy-log';
import { validateTime } from '@/lib/settings';

describe('acme.sh', () => {
  it('liest die Fassung aus der Ausgabe von --version', () => {
    expect(parseAcmeVersion('https://github.com/acmesh-official/acme.sh\nv3.1.2\n')).toBe('3.1.2');
    expect(parseAcmeVersion('bash: acme.sh: command not found')).toBeNull();
  });

  it('vergleicht Fassungen Zahl für Zahl', () => {
    expect(isNewerVersion('3.1.10', '3.1.2')).toBe(true);
    expect(isNewerVersion('3.1.2', '3.1.10')).toBe(false);
    expect(isNewerVersion('3.1.2', '3.1.2')).toBe(false);
    expect(isNewerVersion('4.0', '3.9.9')).toBe(true);
  });
});

describe('Mitschnitt des Logs', () => {
  it('stellt der Zeile einen Kopf voran, hinter dem die Auswertung die Adresse findet', () => {
    const parsed = formatLogLine(
      '2026-11-24T14:00:00.123456789Z 203.0.113.7:51234 [24/Nov/2026:14:00:00.120] https_in~ blog/blog 0/0/1/2/3 200 512 - - ---- 1/1/0/0/0 0/0 "GET / HTTP/2.0"'
    );
    expect(parsed?.stamp).toBe('2026-11-24T14:00:00.123456789Z');
    const fields = parsed!.line.split(' ');
    const date = fields.findIndex((field) => field.startsWith('['));
    // Das Feld vor dem Annahmedatum ist Adresse und Port des Clients.
    expect(fields[date - 1]).toBe('203.0.113.7:51234');
    expect(date).toBeGreaterThanOrEqual(2);
  });

  it('verwirft leere Zeilen und Zeilen ohne Zeitstempel', () => {
    expect(formatLogLine('2026-11-24T14:00:00.1Z ')).toBeNull();
    expect(formatLogLine('ohne zeitstempel')).toBeNull();
  });

  it('ordnet Zeitstempel als Text richtig, darauf beruht das Überspringen nach einem Neustart', () => {
    expect('2026-11-24T14:00:00.123456789Z' < '2026-11-24T14:00:00.223456789Z').toBe(true);
  });
});

describe('Uhrzeit für selbsttätige Updates', () => {
  it('nimmt nur HH:MM', () => {
    expect(validateTime('04:00')).toBe(true);
    expect(validateTime('23:59')).toBe(true);
    expect(validateTime('24:00')).toBe(false);
    expect(validateTime('4:00')).toBe(false);
  });
});
