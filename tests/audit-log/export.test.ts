import { describe, expect, it } from 'vitest';
import {
  auditExportStream,
  csvCell,
  csvDelimiter,
  csvEntry,
  csvHeader,
  exportFileName,
} from '@/lib/audit-log/export';
import type { AuditEntry } from '@/lib/audit-log/read';
import type { AuditFilter } from '@/lib/db/audit-query';
import { createTranslator } from '@/lib/i18n';

/**
 * Der Export des Protokolls.
 *
 * Eine CSV-Datei öffnet jemand in Excel, und im Protokoll steht Text, den auch
 * Fremde bestimmen: der Name, mit dem sich jemand anzumelden versucht, landet
 * in `details`. Beginnt er mit `=`, wäre er dort eine Formel.
 */

const de = createTranslator('de');
const en = createTranslator('en');

function entry(index: number, patch: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: index.toString(16).padStart(32, '0'),
    timestamp: new Date(Date.UTC(2026, 10, 26, 8, 0, index)).toISOString(),
    action: 'login',
    area: 'auth',
    actorType: 'user',
    actor: 'admin@example.org',
    actorId: 'u1',
    resource: null,
    resourceId: null,
    details: null,
    ip: '10.0.0.5',
    outcome: 'success',
    ...patch,
  };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

describe('CSV-Zellen', () => {
  it('setzt jede Zelle in Anführungszeichen und verdoppelt die im Text', () => {
    expect(csvCell('Ziel "shop" geändert')).toBe('"Ziel ""shop"" geändert"');
    expect(csvCell('a;b,c')).toBe('"a;b,c"');
    expect(csvCell(null)).toBe('""');
  });

  it.each(['=1+1', '+49 30 1234', '-2+3', '@SUM(A1)', '\tx', '\rx'])('entschärft %j, das Excel als Formel läse', (text) => {
    expect(csvCell(text)).toBe(`"'${text}"`);
  });

  it('entschärft den bekannten Angriff über DDE', () => {
    expect(csvCell(`=cmd|' /C calc'!A0`)).toBe(`"'=cmd|' /C calc'!A0"`);
  });

  it('lässt gewöhnlichen Text und Zahlen in Ruhe', () => {
    expect(csvCell('10.0.0.5')).toBe('"10.0.0.5"');
    expect(csvCell('2026-11-26T08:00:00.000Z')).toBe('"2026-11-26T08:00:00.000Z"');
  });

  it('behält einen Zeilenumbruch in der Zelle, statt die Zeile zu teilen', () => {
    expect(csvCell('eins\nzwei')).toBe('"eins\nzwei"');
  });

  it('trennt auf Deutsch mit Semikolon, auf Englisch mit Komma', () => {
    expect(csvDelimiter('de')).toBe(';');
    expect(csvDelimiter('en')).toBe(',');
  });
});

describe('CSV-Zeilen', () => {
  it('hat in Kopf und Zeile gleich viele Spalten', () => {
    const header = csvHeader(de.t, ';').trimEnd().split('";"');
    const row = csvEntry(entry(1, { details: 'ohne Trenner' }), de.t, ';').trimEnd().split('";"');
    expect(row).toHaveLength(header.length);
    expect(header).toHaveLength(12);
  });

  it('schreibt den Text der Handlung in der Sprache und ihren Namen dazu', () => {
    const row = csvEntry(entry(1, { action: 'login_failed', outcome: 'failure' }), en.t, ',');
    expect(row).toContain('"Sign-in failed","login_failed","Sign in"');
    expect(row).toContain('"Failure"');
    expect(csvEntry(entry(1, { action: 'login_failed' }), de.t, ';')).toContain('"Anmeldung gescheitert";"login_failed";"Anmeldung"');
  });

  it('zeigt eine Handlung, die es nicht mehr gibt, unter ihrem Namen', () => {
    expect(csvEntry(entry(1, { action: 'alte_handlung', area: null }), de.t, ';')).toContain('"alte_handlung";"alte_handlung";""');
  });

  it('endet jede Zeile mit CRLF', () => {
    expect(csvEntry(entry(1), de.t, ';').endsWith('\r\n')).toBe(true);
  });
});

describe('Strom des Exports', () => {
  function source(total: number) {
    const calls: AuditFilter[] = [];
    const all = Array.from({ length: total }, (_, index) => entry(index + 1));
    const read = async (filter: AuditFilter, limit: number) => {
      calls.push(filter);
      return all.filter((row) => (filter.after ? row.id > filter.after : true)).slice(0, limit);
    };
    return { calls, read };
  }

  it('beginnt als CSV mit BOM und Kopfzeile', async () => {
    const { read } = source(2);
    const text = await readAll(auditExportStream({}, 'csv', { t: de.t, locale: 'de' }, read));
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('"Zeitpunkt (UTC)";"Art";"Wer";"Handlung"');
  });

  it('liefert als JSON Lines je Zeile ein Objekt, ohne BOM', async () => {
    const { read } = source(3);
    const text = await readAll(auditExportStream({}, 'jsonl', { t: de.t, locale: 'de' }, read));
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0])).toMatchObject({ action: 'login', actor: 'admin@example.org' });
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('holt seitenweise und setzt mit der letzten Kennung fort', async () => {
    const { calls, read } = source(2300);
    const text = await readAll(auditExportStream({}, 'jsonl', { t: de.t, locale: 'de' }, read));
    expect(text.trimEnd().split('\n')).toHaveLength(2300);
    expect(calls).toHaveLength(3);
    expect(calls[0].after).toBeUndefined();
    expect(calls[1].after).toBe((1000).toString(16).padStart(32, '0'));
    expect(calls[2].after).toBe((2000).toString(16).padStart(32, '0'));
  });

  it('liest bei jeder Seite bis zur selben Grenze: der Export ist eine Momentaufnahme', async () => {
    const { calls, read } = source(1500);
    await readAll(auditExportStream({}, 'jsonl', { t: de.t, locale: 'de' }, read));
    expect(calls[0].upTo).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(calls.map((call) => call.upTo)).size).toBe(1);
  });

  it('reicht den Filter an jede Seite weiter', async () => {
    const { calls, read } = source(1);
    await readAll(
      auditExportStream({ actor: 'service', area: 'backup', q: 'nacht' }, 'jsonl', { t: de.t, locale: 'de' }, read)
    );
    expect(calls[0].actor).toBe('service');
    expect(calls[0].search).toBe('nacht');
    expect(calls[0].actions).toContain('backup_failed');
    expect(calls[0].actions).not.toContain('login');
  });

  it('liefert ohne Einträge nur die Kopfzeile, als JSON Lines nichts', async () => {
    const { read } = source(0);
    const csv = await readAll(auditExportStream({}, 'csv', { t: de.t, locale: 'de' }, read));
    expect(csv.slice(1).split('\r\n').filter(Boolean)).toHaveLength(1);
    expect(await readAll(auditExportStream({}, 'jsonl', { t: de.t, locale: 'de' }, read))).toBe('');
  });

  it('meldet einen Fehler der Datenbank, statt still eine halbe Datei zu liefern', async () => {
    const read = async () => {
      throw new Error('Verbindung weg');
    };
    await expect(readAll(auditExportStream({}, 'jsonl', { t: de.t, locale: 'de' }, read))).rejects.toThrow('Verbindung weg');
  });
});

describe('Dateiname', () => {
  it('trägt Zeitpunkt und Endung', () => {
    const now = new Date(Date.UTC(2026, 10, 26, 8, 5, 9));
    expect(exportFileName('csv', now)).toBe('hapm-protokoll-20261126-080509.csv');
    expect(exportFileName('jsonl', now)).toBe('hapm-protokoll-20261126-080509.jsonl');
  });
});
