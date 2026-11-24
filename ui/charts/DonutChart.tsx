"use client"

import type { ReactElement, ReactNode } from "react"
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts"
import { ChartEmpty } from "./ChartCard"
import { ChartLegend, ChartTooltipBox, type ChartTooltipRow } from "./ChartTooltip"
import { formatNumber, formatShare, seriesColor } from "./palette"

export interface DonutSlice {
  key: string
  label: string
  value: number
  /** Ohne Angabe aus der Palette, in der Reihenfolge der Teile. */
  color?: string
  /** Klein hinter dem Namen in der Legende, etwa ein Wertebereich. */
  detail?: string
}

/**
 * Ein Ganzes in Teilen, als Ring mit Legende daneben.
 *
 * Höchstens fünf bis sechs Teile: darüber lassen sich Winkel nicht mehr vergleichen, dann
 * ist `BarList` die bessere Form. Die Prozente stehen in der Legende, nicht im Bild. Leere
 * Teile fehlen im Ring, bleiben aber in der Legende: „0 %" ist eine Auskunft.
 */
export function DonutChart({
  slices,
  format = (value) => formatNumber(value),
  valueName = "Wert",
  center,
  size = 150,
  tooltipExtra,
  emptyText = "Noch keine Daten.",
}: {
  slices: DonutSlice[]
  /** Wie ein absoluter Wert im Tooltip steht. */
  format?: (value: number) => string
  /** Bezeichnung des absoluten Werts im Tooltip, etwa „Besucher". */
  valueName?: string
  /** In der Mitte des Rings, etwa die Summe. */
  center?: { value: ReactNode; label?: ReactNode }
  size?: number
  tooltipExtra?: (slice: DonutSlice) => ChartTooltipRow[]
  emptyText?: ReactNode
}): ReactElement {
  const total = slices.reduce((sum, slice) => sum + Math.max(0, slice.value), 0)
  if (total === 0) return <ChartEmpty height={size}>{emptyText}</ChartEmpty>

  const colored = slices.map((slice, i) => ({ ...slice, color: slice.color ?? seriesColor(i), share: slice.value / total }))
  const drawn = colored.filter((slice) => slice.value > 0)

  return (
    <div className="viz-donut">
      <div className="viz-donut__chart" style={{ width: size, height: size }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={drawn}
              dataKey="value"
              nameKey="label"
              innerRadius="62%"
              outerRadius="100%"
              startAngle={90}
              endAngle={-270}
              // Zwei Grad Abstand und ein Rand in der Flächenfarbe: die Trennung zwischen
              // zwei Teilen darf nicht selbst wie ein dritter aussehen.
              paddingAngle={drawn.length > 1 ? 2 : 0}
              cornerRadius={3}
              stroke="var(--surface)"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {drawn.map((slice) => (
                <Cell key={slice.key} fill={slice.color} />
              ))}
            </Pie>
            <Tooltip
              isAnimationActive={false}
              content={(props: { active?: boolean; payload?: readonly { payload?: unknown }[] }) => {
                const slice = props.payload?.[0]?.payload as (typeof colored)[number] | undefined
                if (!props.active || !slice) return null
                return (
                  <ChartTooltipBox
                    title={slice.label}
                    rows={[
                      { key: "share", name: "Anteil", value: formatShare(slice.share), color: slice.color },
                      { key: "value", name: valueName, value: format(slice.value) },
                      ...(tooltipExtra?.(slice) ?? []),
                    ]}
                  />
                )
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        {center && (
          <div className="viz-donut__center" aria-hidden="true">
            <span className="viz-donut__center-value">{center.value}</span>
            {center.label && <span className="viz-donut__center-label">{center.label}</span>}
          </div>
        )}
      </div>
      <ChartLegend
        layout="list"
        items={colored.map((slice) => ({
          key: slice.key,
          name: slice.label,
          color: slice.color,
          detail: slice.detail,
          value: formatShare(slice.share),
        }))}
      />
    </div>
  )
}

export default DonutChart
