/**
 * Die Typen und die Palette der Diagramme.
 *
 * Rein und ohne React, damit Seiten und `MetricChart` dieselbe Datei nehmen.
 */

export interface ChartPoint {
  /** Millisekunden seit Epoch. */
  t: number;
  [key: string]: number | null;
}

export interface ChartSeries {
  key: string;
  name: string;
  color: string;
}

/**
 * Palette und Farbe je Reihe stehen in `ui/charts/palette.ts` (dort die
 * Begründung der Reihenfolge und der Stufen ab der neunten Reihe). Hier nur
 * weitergereicht, damit die Seiten Typen und Palette aus einer Datei nehmen.
 */
export { VIZ_COLORS, DISTINCT_SERIES, seriesColor } from '@/ui/charts/palette';
