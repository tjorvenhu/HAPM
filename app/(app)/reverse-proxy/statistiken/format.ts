/**
 * Die Zahlenformate der Statistik-Seite, je Sprache einmal.
 *
 * Was eine Zahl wird, steht in `lib/i18n/format.ts` (`formatCount`,
 * `formatCountShort`, `formatKb`, `formatMs`). Hier stehen nur die Funktionen,
 * die die Diagramme bekommen, als **Modulkonstanten** je Sprache und nicht als
 * Pfeile im JSX, und das ist keine Stilfrage: `MetricChart` ist memoisiert, und
 * die Memoisierung greift nur, wenn `format` und `series` zwischen zwei
 * Renderdurchläufen dieselben Objekte sind. Ein `format={(v) => ...}` im JSX ist
 * bei jedem Durchlauf ein neues und baut Recharts jedes Mal neu auf. Siehe
 * docs/ui.md.
 */

import {
  formatCount,
  formatCountShort,
  formatKb,
  formatMs,
  LOCALES,
  translate,
  type Locale,
} from '@/lib/i18n';
import type { ChartSeries } from '@/lib/systems/series';

export interface StatsFormats {
  /** Tausendertrennung, sonst nichts. Anfragen sind ganze Dinge. */
  count: (value: number) => string;
  /**
   * Große Anzahlen an einer Achse: „1,2 Mio." statt „1.243.881". An einer
   * Y-Achse mit 68 Pixeln Breite bricht die volle Zahl um, und dann steht sie
   * zweizeilig neben einem 190 Pixel hohen Diagramm.
   */
  countShort: (value: number) => string;
  /** Kilobyte in die passende Einheit. Die Zeitreihe führt KB, siehe `bytesInKb`. */
  kb: (value: number) => string;
  /** Millisekunden, ab einer Sekunde in Sekunden. */
  ms: (value: number) => string;
}

function perLocale<T>(build: (locale: Locale) => T): Readonly<Record<Locale, T>> {
  return Object.fromEntries(LOCALES.map((locale) => [locale, build(locale)])) as Record<Locale, T>;
}

export const STATS_FORMATS = perLocale<StatsFormats>((locale) => ({
  count: (value) => formatCount(locale, value),
  countShort: (value) => formatCountShort(locale, value),
  kb: (value) => formatKb(locale, value),
  ms: (value) => formatMs(locale, value),
}));

/**
 * Die Reihen eines Diagramms mit übersetzten Namen, je Sprache einmal. Die
 * Namen kommen als `msgid` hinein. Aus demselben Grund stabil wie die Formate:
 * sie stehen in der Legende und im Tooltip von `MetricChart`.
 */
export function seriesPerLocale(series: ChartSeries[]): Readonly<Record<Locale, ChartSeries[]>> {
  return perLocale((locale) => series.map((entry) => ({ ...entry, name: translate(locale, entry.name) })));
}
