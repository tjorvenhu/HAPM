"use client"

import { memo, useId, type ReactElement, type ReactNode } from "react"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { ChartEmpty } from "./ChartCard"
import { ChartLegend, ChartTooltipBox, type ChartTooltipRow } from "./ChartTooltip"
import {
  AXIS_TICK,
  MISSING,
  TONE_COLOR,
  formatAxisTime,
  formatNumber,
  formatTooltipTime,
  seriesColor,
  type ChartTone,
} from "./palette"

export interface ChartSeries {
  /** Feld in den Daten. */
  key: string
  /** Name in Tooltip und Legende. */
  name: string
  /** Ohne Angabe: eine Reihe allein im Akzent, mehrere aus der Palette (`seriesColor`). */
  color?: string
}

/** Eine waagerechte Linie mit Beschriftung, etwa eine Grenze („hörbar", „Limit"). */
export interface ChartReference {
  y: number
  label?: string
  tone?: ChartTone
}

type Row = object

/** Ein Feld eines Datenpunkts, gleich welchen Typs der Punkt beim Aufrufer hat. */
function field(row: object | undefined, key: string): unknown {
  return row ? (row as Record<string, unknown>)[key] : undefined
}

export interface TimeSeriesChartProps<T extends Row> {
  data: T[]
  series: ChartSeries[]
  /** Feld der x-Achse. Vorgabe `t`. */
  x?: string
  /**
   * `time`: Millisekunden auf einer echten Zeitachse. Fällt eine Messung aus, bleibt der
   * Abstand sichtbar. `category`: gleichmäßige Schritte (Tage als Text, Namen).
   */
  xType?: "time" | "category"
  /** Beschriftung der x-Achse. Vorgabe bei `time`: Datum oder Uhrzeit nach `rangeMs`. */
  xFormat?: (value: never) => string
  /** Breite des gezeigten Zeitraums, entscheidet bei `time` über das Achsenformat. */
  rangeMs?: number
  /** Wie ein Wert an der Achse und im Tooltip steht. Vorgabe: Zahl ohne Nachkommastellen. */
  format?: (value: number) => string
  /** Beschriftung der y-Achse, wenn sie anders aussehen soll als im Tooltip. Vorgabe `format`. */
  yFormat?: (value: number) => string
  /**
   * `line` für Momentanwerte mehrerer Reihen, `area` für eine Reihe (mit Verlauf darunter)
   * oder einen Stapel, `bars` für Summen über ein Fenster („Anfragen je Stunde"): eine Linie
   * zwischen zwei Balken behauptete einen Verlauf, den es nicht gibt.
   */
  variant?: "line" | "area" | "bars"
  /** Teile einer Summe übereinander, mit Summe im Tooltip. */
  stacked?: boolean
  /** Bereich der y-Achse. Vorgabe `[0, auto]`. */
  domain?: [number | "auto" | "dataMin", number | "auto" | "dataMax"]
  /** Feste Striche der y-Achse. */
  ticks?: number[]
  /** Nur ganze Zahlen an der y-Achse (Anzahlen). */
  integers?: boolean
  /** Breite der y-Achse in Pixeln. Vorgabe 68: reicht für „8,00 MB/s" und „100,0 %". */
  yWidth?: number
  height?: number
  references?: ChartReference[]
  /** Punkte auf der Kurve. Vorgabe: bei einer Reihe mit höchstens 45 Punkten. */
  dots?: boolean
  /**
   * Verlauf unter den Linien. Vorgabe: bei bis zu drei Reihen ja (wie eine Fläche, schwächer
   * je mehr Reihen), darüber nein: ab vier Flächen verdecken sie sich gegenseitig.
   */
  fill?: boolean
  /** Überschrift im Tooltip. Vorgabe: Zeitpunkt bzw. beschrifteter x-Wert. */
  tooltipTitle?: (row: T) => ReactNode
  /** Weitere Zeilen im Tooltip, etwa eine Anzahl zum Mittelwert. */
  tooltipExtra?: (row: T) => ChartTooltipRow[]
  /** Kleingedrucktes unten im Tooltip, etwa „Klicken für Details". */
  tooltipHint?: ReactNode
  /** Klick auf einen Zeitpunkt. */
  onPointClick?: (row: T) => void
  /** Macht die Legende anklickbar, bekommt den Schlüssel der Reihe. */
  onSelect?: (key: string) => void
  /** Legende ab zwei und bis acht Reihen. Mit `false` nie. */
  legend?: boolean
  /** Wie viele Zeitpunkte mit Wert es mindestens braucht. Vorgabe 1. */
  minPoints?: number
  /** Lauter Nullen gelten als leer (Anzahlen: „keine Alarme" statt einer Linie am Boden). */
  emptyIfZero?: boolean
  emptyText?: ReactNode
}

/**
 * Ab wann eine Legende keine mehr ist: bei dreißig Reihen stünden dreißig abgeschnittene
 * Namen unter dem Diagramm. Darüber nennt der Tooltip jede Reihe beim Namen.
 */
const LEGEND_MAX = 8

/**
 * Das Diagramm für alles, was über eine Achse verläuft: Linie, Fläche, Balken.
 *
 * Feste Regeln, die überall gelten:
 * - **Lücken bleiben Lücken** (`connectNulls` aus). Eine Linie über eine Zeit ohne Messung
 *   behauptete einen Verlauf, den niemand gemessen hat.
 * - **Eine y-Achse.** Zwei Größen mit verschiedener Einheit gehören in zwei Diagramme.
 * - Eine Reihe allein steht im Akzent mit Verlauf darunter, mehrere bekommen die Palette
 *   in fester Reihenfolge und eine Legende.
 * - Keine Animation: die Diagramme laden alle paar Sekunden neu.
 *
 * Memoisiert: `data`, `series` und `format` müssen stabil sein (Modulkonstante oder
 * `useMemo`), sonst zeichnet recharts bei jedem Rendern der Seite neu.
 */
function TimeSeriesChartImpl<T extends Row>({
  data,
  series,
  x = "t",
  xType = "time",
  xFormat,
  rangeMs,
  format = formatNumber,
  yFormat,
  variant = "line",
  stacked = false,
  domain,
  ticks,
  integers = false,
  yWidth = 68,
  height = 200,
  references,
  dots,
  fill,
  tooltipTitle,
  tooltipExtra,
  tooltipHint,
  onPointClick,
  onSelect,
  legend = true,
  minPoints = 1,
  emptyIfZero = false,
  emptyText = "Für diesen Zeitraum liegen keine Messwerte vor.",
}: TimeSeriesChartProps<T>): ReactElement {
  const gradientBase = `viz-fill-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`

  const measured = data.filter((row) => series.some((s) => typeof field(row, s.key) === "number")).length
  const allZero =
    emptyIfZero && data.every((row) => series.every((s) => !field(row, s.key)))
  if (allZero || measured < Math.max(1, minPoints)) {
    return <ChartEmpty height={height}>{emptyText}</ChartEmpty>
  }

  const single = series.length === 1
  const colors = series.map((s, i) => s.color ?? (single ? "var(--accent)" : seriesColor(i)))
  const showDots = dots ?? (single && variant !== "bars" && data.length <= 45)
  // Eine Linie mit Verlauf ist eine Fläche ohne Stapel. Bis drei Reihen bleibt jede lesbar.
  const filled = variant === "area" || (variant === "line" && (fill ?? series.length <= 3))
  const fillTop = single ? 0.28 : series.length === 2 ? 0.24 : 0.18

  const timeRange =
    rangeMs ??
    (xType === "time" && data.length > 1
      ? Math.abs(Number(field(data[data.length - 1], x)) - Number(field(data[0], x)))
      : 0)
  const formatX = (value: unknown): string => {
    if (xFormat) return (xFormat as (v: unknown) => string)(value)
    if (xType === "time" && typeof value === "number") return formatAxisTime(value, timeRange)
    return String(value ?? "")
  }

  const tooltip = (
    <Tooltip
      cursor={variant === "bars" ? { fill: "var(--accent-subtle, rgba(0, 0, 0, 0.04))" } : { stroke: "var(--border-hover)", strokeWidth: 1 }}
      isAnimationActive={false}
      content={(props: { active?: boolean; payload?: readonly { payload?: unknown }[] }) => {
        const row = props.payload?.[0]?.payload as T | undefined
        if (!props.active || !row) return null
        const rows: ChartTooltipRow[] = series.map((s, i) => {
          const value = field(row, s.key)
          return {
            key: s.key,
            name: s.name,
            color: colors[i],
            value: typeof value === "number" ? format(value) : MISSING,
          }
        })
        // Viele Reihen nach Wert, damit oben steht, wer gerade vorn liegt. Reihen ohne
        // Messung ganz unten.
        if (series.length > 3) {
          const valueOf = (key: string) => {
            const value = field(row, key)
            return typeof value === "number" ? value : null
          }
          rows.sort((a, b) => {
            const av = valueOf(a.key)
            const bv = valueOf(b.key)
            if (av === null && bv === null) return 0
            if (av === null) return 1
            if (bv === null) return -1
            return bv - av
          })
        }
        const values = series.map((s) => field(row, s.key)).filter((v): v is number => typeof v === "number")
        // Die Summe nur unter einem Stapel: dort ist sie die Höhe der Fläche.
        const total = stacked && values.length > 1 ? { name: "Summe", value: format(values.reduce((a, b) => a + b, 0)) } : undefined
        const xValue = field(row, x)
        const title = tooltipTitle
          ? tooltipTitle(row)
          : xType === "time" && typeof xValue === "number"
            ? formatTooltipTime(xValue)
            : formatX(xValue)
        return (
          <ChartTooltipBox
            title={title}
            rows={[...rows, ...(tooltipExtra?.(row) ?? [])]}
            total={total}
            hint={tooltipHint}
          />
        )
      }}
    />
  )

  const axes = (
    <>
      <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
      <XAxis
        dataKey={x}
        type={xType === "time" ? "number" : "category"}
        scale={xType === "time" ? "time" : "auto"}
        domain={xType === "time" ? ["dataMin", "dataMax"] : undefined}
        tick={AXIS_TICK}
        axisLine={{ stroke: "var(--border)" }}
        tickLine={false}
        // „31.07." ist bei 11 px rund 40 px breit. Weniger Abstand, und zwei Daten lesen
        // sich als eine Zahlenreihe.
        minTickGap={xType === "time" ? 64 : 24}
        tickFormatter={formatX}
        padding={variant === "bars" ? undefined : { left: 6, right: 6 }}
      />
      <YAxis
        tick={AXIS_TICK}
        axisLine={false}
        tickLine={false}
        // Zu schmal, und recharts bricht die Beschriftung auf zwei Zeilen um.
        width={yWidth}
        domain={domain ?? [0, "auto"]}
        ticks={ticks}
        allowDecimals={!integers}
        tickFormatter={(value: number) => (yFormat ?? format)(value)}
      />
      {references?.map((ref) => {
        const color = TONE_COLOR[ref.tone ?? "warning"]
        return (
          <ReferenceLine
            key={`${ref.y}-${ref.label ?? ""}`}
            y={ref.y}
            stroke={color}
            strokeDasharray="4 4"
            ifOverflow="extendDomain"
            label={ref.label ? { value: ref.label, position: "insideTopRight", fontSize: 10, fill: color } : undefined}
          />
        )
      })}
      {tooltip}
    </>
  )

  const margin = { top: 8, right: 8, left: 0, bottom: 0 }
  const handleClick = onPointClick
    ? (state: unknown) => {
        const s = state as { activeTooltipIndex?: number | string | null; activeIndex?: number | string | null }
        const index = Number(s?.activeTooltipIndex ?? s?.activeIndex)
        const row = Number.isFinite(index) ? data[index] : undefined
        if (row) onPointClick(row)
      }
    : undefined
  const chartStyle = onPointClick ? { cursor: "pointer" } : undefined

  const dot = (color: string) =>
    showDots ? { r: 3, fill: color, stroke: "var(--surface)", strokeWidth: 2 } : false
  const activeDot = (color: string) =>
    single || series.length <= 3 ? { r: 5, fill: color, stroke: "var(--surface)", strokeWidth: 2 } : false

  let chart: ReactElement
  if (variant === "bars") {
    chart = (
      <BarChart data={data} margin={margin} onClick={handleClick} style={chartStyle}>
        {axes}
        {series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.name}
            stackId={stacked ? "stack" : undefined}
            fill={colors[i]}
            // Ein runder Abschluss nur oben auf einem freistehenden Balken. Im Stapel ließe
            // er zwischen zwei Teilen eine Lücke sehen, die es in den Zahlen nicht gibt.
            radius={stacked ? 0 : [4, 4, 0, 0]}
            // Ohne Deckel wird aus drei Punkten auf 900 px ein Balken von 300 px.
            maxBarSize={28}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    )
  } else if (filled || stacked) {
    chart = (
      <AreaChart data={data} margin={margin} onClick={handleClick} style={chartStyle}>
        <defs>
          {series.map((s, i) => (
            <linearGradient key={s.key} id={`${gradientBase}-${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colors[i]} stopOpacity={fillTop} />
              <stop offset="100%" stopColor={colors[i]} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        {axes}
        {series.map((s, i) => (
          <Area
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.name}
            stackId={stacked ? "stack" : undefined}
            stroke={colors[i]}
            // Ein Band im Stapel ist eine Fläche, keine Kurve: dünne Kontur, deckende Farbe.
            strokeWidth={stacked ? 1 : 2}
            fill={stacked ? colors[i] : `url(#${gradientBase}-${i})`}
            fillOpacity={1}
            dot={stacked ? false : dot(colors[i] ?? "var(--accent)")}
            activeDot={stacked ? false : activeDot(colors[i] ?? "var(--accent)")}
            connectNulls={false}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    )
  } else {
    chart = (
      <LineChart data={data} margin={margin} onClick={handleClick} style={chartStyle}>
        {axes}
        {series.map((s, i) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.name}
            stroke={colors[i]}
            strokeWidth={2}
            dot={dot(colors[i] ?? "var(--accent)")}
            activeDot={activeDot(colors[i] ?? "var(--accent)")}
            connectNulls={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    )
  }

  return (
    <>
      <ResponsiveContainer width="100%" height={height}>
        {chart}
      </ResponsiveContainer>
      {legend && series.length > 1 && series.length <= LEGEND_MAX && (
        <ChartLegend
          items={series.map((s, i) => ({ key: s.key, name: s.name, color: colors[i] ?? seriesColor(i) }))}
          onSelect={onSelect}
        />
      )}
    </>
  )
}

// `memo` verliert den Typparameter, deshalb der ausdrückliche Typ.
export const TimeSeriesChart: <T extends Row>(props: TimeSeriesChartProps<T>) => ReactElement = memo(
  TimeSeriesChartImpl
) as never

export default TimeSeriesChart
