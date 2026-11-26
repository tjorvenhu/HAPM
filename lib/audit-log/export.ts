/**
 * Das Protokoll als Datei: CSV für die Tabellenkalkulation, JSON Lines für
 * alles, was es weiterverarbeitet.
 *
 * Gestreamt und seitenweise aus der Datenbank gelesen: ein Jahr Protokoll soll
 * weder im Speicher des Servers noch in einer einzigen Abfrage stehen. Der
 * Export ist eine Momentaufnahme: er endet an dem Eintrag, der beim Start der
 * jüngste feste war, auch wenn währenddessen neue dazukommen.
 *
 * ── CSV und Formeln ──
 *
 * Eine Zelle, die mit `=`, `+`, `-` oder `@` beginnt, liest Excel als Formel.
 * In `details` steht Text, den auch Fremde bestimmen (der Name, mit dem sich
 * jemand anzumelden versucht). Solche Zellen bekommen ein `'` davor: Excel
 * zeigt sie dann als Text. Jede Zelle steht in Anführungszeichen.
 */

import type { Locale } from '../i18n/locale';
import { msgid, type Translator } from '../i18n/translate';
import { queryAudit, type AuditFilter } from '../db/audit-query';
import { AUDIT_AREA_LABELS, labelOf } from './labels';
import { filterOf, settledId, toEntry, type AuditEntry, type AuditQuery } from './read';

export const EXPORT_FORMATS = ['csv', 'jsonl'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

const PAGE = 1000;

/** Byte Order Mark, aus der Zeichennummer: als Zeichen im Quelltext sähe es niemand. */
const BOM = String.fromCharCode(0xfeff);

const ACTOR_TYPE_LABELS: Record<AuditEntry['actorType'], string> = {
  user: msgid('Konto'),
  service: msgid('API-Key'),
  system: msgid('System'),
};

const COLUMNS = [
  msgid('Zeitpunkt (UTC)'),
  msgid('Art'),
  msgid('Wer'),
  msgid('Handlung'),
  msgid('Kennung der Handlung'),
  msgid('Bereich'),
  msgid('Gegenstand'),
  msgid('Kennung des Gegenstands'),
  msgid('Einzelheiten'),
  msgid('Adresse'),
  msgid('Ergebnis'),
  msgid('Kennung des Eintrags'),
] as const;

const OUTCOME_LABELS: Record<AuditEntry['outcome'], string> = {
  success: msgid('Erfolg'),
  failure: msgid('Fehlschlag'),
};

export function csvCell(value: string | null | undefined): string {
  let text = value ?? '';
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function csvRow(cells: (string | null | undefined)[], delimiter: string): string {
  return `${cells.map(csvCell).join(delimiter)}\r\n`;
}

/** Deutsch rechnet mit Komma: Excel erwartet dort das Semikolon als Trenner. */
export function csvDelimiter(locale: Locale): string {
  return locale === 'de' ? ';' : ',';
}

export function csvHeader(t: Translator['t'], delimiter: string): string {
  return csvRow(COLUMNS.map((column) => t(column)), delimiter);
}

export function csvEntry(entry: AuditEntry, t: Translator['t'], delimiter: string): string {
  const label = labelOf(entry.action);
  return csvRow(
    [
      entry.timestamp,
      t(ACTOR_TYPE_LABELS[entry.actorType]),
      entry.actor,
      label ? t(label) : entry.action,
      entry.action,
      entry.area ? t(AUDIT_AREA_LABELS[entry.area]) : '',
      entry.resource,
      entry.resourceId,
      entry.details,
      entry.ip,
      t(OUTCOME_LABELS[entry.outcome]),
      entry.id,
    ],
    delimiter
  );
}

export function exportFileName(format: ExportFormat, now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  return `hapm-protokoll-${stamp}.${format === 'csv' ? 'csv' : 'jsonl'}`;
}

export const EXPORT_CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  jsonl: 'application/x-ndjson; charset=utf-8',
};

export type ExportQuery = Pick<AuditQuery, 'from' | 'to' | 'actor' | 'area' | 'q'>;

/**
 * Die gefilterten Einträge vom ältesten zum jüngsten. `read` ist die Abfrage
 * der Datenbank, austauschbar für den Test.
 */
export function auditExportStream(
  query: ExportQuery,
  format: ExportFormat,
  language: { t: Translator['t']; locale: Locale },
  read: (filter: AuditFilter, limit: number) => Promise<AuditEntry[]> = async (filter, limit) =>
    (await queryAudit(filter, 'asc', limit)).map(toEntry)
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const delimiter = csvDelimiter(language.locale);
  const upTo = settledId();
  let after: string | undefined;
  let started = false;
  let finished = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!started) {
          started = true;
          // Das BOM sagt Excel, dass die Datei UTF-8 ist. Sonst werden Umlaute zu Zeichensalat.
          if (format === 'csv') controller.enqueue(encoder.encode(BOM + csvHeader(language.t, delimiter)));
        }
        if (finished) {
          controller.close();
          return;
        }
        const entries = await read({ ...filterOf(query), after, upTo }, PAGE);
        if (entries.length < PAGE) finished = true;
        if (entries.length === 0) {
          controller.close();
          return;
        }
        after = entries[entries.length - 1].id;
        const text =
          format === 'csv'
            ? entries.map((entry) => csvEntry(entry, language.t, delimiter)).join('')
            : entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');
        controller.enqueue(encoder.encode(text));
      } catch (err) {
        controller.error(err);
      }
    },
  });
}
