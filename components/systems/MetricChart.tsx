'use client';

import { memo } from 'react';
import { TimeSeriesChart } from '@/ui/charts/TimeSeriesChart';
import { VIZ_COLORS } from '@/lib/systems/series';
import type { ChartPoint, ChartSeries } from '@/lib/systems/series';

/**
 * Das Diagramm der Statistik. Form, Tooltip, Legende und Palette stehen in
 * `ui/charts/TimeSeriesChart.tsx`; hier stehen nur die Vorgaben der Statistik
 * (Zeitachse über `t`, eine Obergrenze für Prozente), damit die Aufrufer gleich
 * bleiben.
 *
 * Memoisiert: die Detailansicht rendert jede Sekunde neu (für „erfasst vor 11
 * Sekunden"). `format` und `series` müssen deshalb stabil sein, Modulkonstanten
 * oder `useMemo`, nie ein Pfeil im JSX.
 */

interface MetricChartProps {
  data: ChartPoint[];
  series: ChartSeries[];
  /** Wie ein Wert im Tooltip und an der Achse steht. */
  format: (value: number) => string;
  /** Breite des dargestellten Zeitraums, entscheidet über das Achsenformat. */
  rangeMs: number;
  /** Gestapelte Flächen (Speicherbänder, Container) statt Linien. */
  stacked?: boolean;
  /**
   * Fläche unter jeder Linie, ungestapelt: je Reihe ein Verlauf, der nach unten
   * ausläuft und mit mehr Reihen blasser wird (`TimeSeriesChart`). Geht deshalb
   * auch bei mehreren Reihen, anders als `stacked`, dessen Bänder deckend sind.
   */
  area?: boolean;
  /** Balken für Summen über ein Fenster („Anfragen je Stunde"), mehrere Reihen gestapelt. */
  bars?: boolean;
  /** Feste Obergrenze, z. B. 100 bei Prozentwerten. */
  max?: number;
  /** Anzahlen: nur ganze Zahlen an der Achse. Sonst steht bei kleinen Werten „1, 1, 2, 2" da. */
  integers?: boolean;
  height?: number;
  /** Macht die Legende anklickbar (Container: der Name führt in die Detailansicht). */
  onSelect?: (name: string) => void;
}

function MetricChart({
  data,
  series,
  format,
  rangeMs,
  stacked = false,
  area = false,
  bars = false,
  max,
  integers = false,
  height = 190,
  onSelect,
}: MetricChartProps) {
  // Eine Reihe allein steht im Akzent, wie überall. Die Seiten geben ihr aus
  // Gewohnheit den ersten Platz der Palette mit.
  const shown =
    series.length === 1 && series[0]?.color === VIZ_COLORS[0]
      ? [{ ...series[0], color: undefined }]
      : series;
  const nameByKey = new Map(series.map((s) => [s.key, s.name]));

  return (
    <TimeSeriesChart
      data={data}
      series={shown}
      x="t"
      xType="time"
      rangeMs={rangeMs}
      format={format}
      variant={bars ? 'bars' : area || stacked ? 'area' : 'line'}
      stacked={stacked || (bars && series.length > 1)}
      domain={max === undefined ? undefined : [0, max]}
      integers={integers}
      height={height}
      dots={false}
      onSelect={onSelect ? (key) => onSelect(nameByKey.get(key) ?? key) : undefined}
    />
  );
}

export default memo(MetricChart);

export { ChartCard } from '@/ui/charts/ChartCard';
