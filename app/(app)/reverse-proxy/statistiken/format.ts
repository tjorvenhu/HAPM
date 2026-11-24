/**
 * Die Zahlenformate der Statistik-Seite.
 *
 * Als **Modulkonstanten** und nicht als Pfeile im JSX, und das ist keine
 * Stilfrage: `MetricChart` ist memoisiert, und die Memoisierung greift nur,
 * wenn `format` und `series` zwischen zwei Renderdurchläufen dieselben Objekte
 * sind. Ein `format={(v) => ...}` im JSX ist bei jedem Durchlauf ein neues und
 * baut Recharts jedes Mal neu auf. Dieselbe Regel wie in
 * `lib/systems/format.ts`, siehe docs/ui.md.
 *
 * Eine eigene Datei neben der Seite und nicht in `lib/systems/format.ts`: die
 * dortigen Formate sind Prozent, Load und Temperatur. Anfragen und übertragene
 * Menge sind andere Größen, und die Datei dort ist die der Systemansicht.
 */

/** Tausendertrennung, sonst nichts. Anfragen sind ganze Dinge. */
export function fmtCount(value: number): string {
  return Math.round(value).toLocaleString('de-DE');
}

/**
 * Große Anzahlen an einer Achse.
 *
 * „1,2 Mio." statt „1.243.881": an einer Y-Achse mit 68 Pixeln Breite bricht
 * die volle Zahl um, und dann steht sie zweizeilig neben einem 190 Pixel hohen
 * Diagramm.
 */
export function fmtCountShort(value: number): string {
  const rounded = Math.round(value);
  if (rounded >= 1_000_000) return `${(rounded / 1_000_000).toLocaleString('de-DE', DECIMAL)} Mio.`;
  if (rounded >= 10_000) return `${(rounded / 1000).toLocaleString('de-DE', DECIMAL)} Tsd.`;
  return rounded.toLocaleString('de-DE');
}

const DECIMAL = { minimumFractionDigits: 1, maximumFractionDigits: 1 } as const;

/** Kilobyte in die passende Einheit. Die Zeitreihe führt KB, siehe `bytesInKb`. */
export function fmtKb(value: number): string {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toLocaleString('de-DE', DECIMAL)} GB`;
  if (value >= 1024) return `${(value / 1024).toLocaleString('de-DE', DECIMAL)} MB`;
  return `${Math.round(value).toLocaleString('de-DE')} KB`;
}

/** Bytes, wie sie aus dem Access-Log kommen. */
export function fmtBytes(value: number): string {
  return fmtKb(value / 1024);
}

/** Millisekunden. Ab einer Sekunde in Sekunden — „2400 ms" liest niemand als
 *  „das dauert zweieinhalb Sekunden". */
export function fmtMs(value: number): string {
  if (value >= 1000) return `${(value / 1000).toLocaleString('de-DE', DECIMAL)} s`;
  return `${Math.round(value).toLocaleString('de-DE')} ms`;
}

/** Ein Anteil als Prozent, mit einer Nachkommastelle. `null` bleibt ein Strich. */
export function fmtShare(value: number | null): string {
  if (value === null) return '–';
  return `${(value * 100).toLocaleString('de-DE', DECIMAL)} %`;
}
