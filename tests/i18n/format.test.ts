import { describe, it, expect } from 'vitest';
import {
  formatBytes,
  formatCountShort,
  formatDate,
  formatDateTime,
  formatDuration,
  formatMs,
  formatNumber,
  formatRelative,
  formatShare,
} from '@/lib/i18n';
import { formatAgo, formatUptime, formatDateTime as legacyDateTime } from '@/components/system/format';

/** Zahlen und Datum je Sprache. Die alten Hilfen bleiben ohne Sprache deutsch. */

const NOW = Date.parse('2026-11-24T12:00:00Z');
const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();

describe('Zahlen', () => {
  it('trennt Tausender und Nachkommastellen nach der Sprache', () => {
    expect(formatNumber('de', 1234.5, 1)).toBe('1.234,5');
    expect(formatNumber('en', 1234.5, 1)).toBe('1,234.5');
  });

  it('schreibt Prozent mit und ohne Leerzeichen', () => {
    expect(formatShare('de', 0.5)).toBe('50 %');
    expect(formatShare('en', 0.05)).toBe('5.0%');
    expect(formatShare('en', null)).toBe('–');
  });

  it('kürzt große Anzahlen und Größen', () => {
    expect(formatCountShort('de', 1_243_881)).toBe('1,2 Mio.');
    expect(formatCountShort('en', 1_243_881)).toBe('1.2M');
    expect(formatCountShort('en', 12_400)).toBe('12.4k');
    expect(formatBytes('de', 5 * 1024 * 1024)).toBe('5,0 MB');
    expect(formatMs('en', 2400)).toBe('2.4 s');
  });
});

describe('Datum', () => {
  it('schreibt das Datum in der Reihenfolge der Sprache', () => {
    expect(formatDate('de', '2026-11-24T12:00:00Z')).toBe('24.11.2026');
    expect(formatDate('en', '2026-11-24T12:00:00Z')).toBe('11/24/2026');
  });

  it('nennt fehlende Werte unbekannt und lässt unlesbare stehen', () => {
    expect(formatDateTime('de', null)).toBe('Unbekannt');
    expect(formatDateTime('en', null)).toBe('Unknown');
    expect(formatDate('en', 'kein Datum')).toBe('kein Datum');
  });
});

describe('Zeitspannen', () => {
  it('sagt, wie lange etwas her ist', () => {
    expect(formatRelative('de', NOW, minutesAgo(0))).toBe('vor weniger als einer Minute');
    expect(formatRelative('de', NOW, minutesAgo(1))).toBe('vor 1 Minute');
    expect(formatRelative('en', NOW, minutesAgo(3))).toBe('3 minutes ago');
    expect(formatRelative('en', NOW, minutesAgo(60 * 50))).toBe('2 days ago');
  });

  it('nennt eine Laufzeit', () => {
    expect(formatDuration('de', NOW, minutesAgo(12))).toBe('12 Min.');
    expect(formatDuration('de', NOW, minutesAgo(60 * 76 + 5))).toBe('3 Tage 4 Std.');
    expect(formatDuration('en', NOW, minutesAgo(60 * 5 + 12))).toBe('5 h 12 min');
    expect(formatDuration('en', NOW, minutesAgo(60 * 25))).toBe('1 day 1 h');
  });

  it('die Hilfen in components/system/format.ts bleiben ohne Sprache deutsch', () => {
    expect(formatAgo(NOW, minutesAgo(5))).toBe('vor 5 Minuten');
    expect(formatUptime(NOW, minutesAgo(30))).toBe('30 Min.');
    expect(legacyDateTime(null)).toBe('Unbekannt');
    expect(formatAgo(NOW, minutesAgo(5), 'en')).toBe('5 minutes ago');
  });
});
