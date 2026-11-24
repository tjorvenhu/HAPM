"use client"

import type { ReactElement, ReactNode } from "react"
import { useT } from "@/lib/i18n/react"
import { formatNumber, formatShare } from "./palette"

export interface BarListItem {
  key: string
  label: ReactNode
  value: number
  /** Ohne Angabe der Akzent. Eigene Farben nur, wenn die Farbe etwas bedeutet. */
  color?: string
  /** Kleine zweite Zeile unter dem Namen. */
  detail?: ReactNode
  /** Vor dem Namen, etwa eine Flagge oder ein Symbol. */
  icon?: ReactNode
  /** Der volle Name beim Überfahren, wenn `label` gekürzt ist (lange Adressen). */
  title?: string
}

/**
 * Eine Rangliste als Balken: Name links, Wert rechts, darunter der Balken. Für „Top 10"
 * (Länder, Szenarien, IPs), Zeit je Bereich und alles, was nach Größe sortiert ist.
 *
 * Kein recharts: eine Liste aus HTML lässt sich lesen, kopieren und anklicken, und lange
 * Namen brechen um statt abgeschnitten an einer Achse zu stehen. Die Balken sind relativ
 * zum größten Wert (oder zu `max`).
 */
export function BarList({
  items,
  format: formatProp,
  max,
  share = false,
  limit,
  onSelect,
  emptyText,
}: {
  items: BarListItem[]
  format?: (value: number) => string
  /** Bezugsgröße der Balken, etwa 100 bei Prozent. Vorgabe: der größte Wert. */
  max?: number
  /** Den Anteil an der Summe neben dem Wert zeigen. */
  share?: boolean
  limit?: number
  /** Macht die Zeilen zu Knöpfen, bekommt den Schlüssel. */
  onSelect?: (key: string) => void
  emptyText?: ReactNode
}): ReactElement {
  const { t, locale } = useT()
  const format = formatProp ?? ((value: number) => formatNumber(value, 0, locale))
  if (items.length === 0) return <div className="viz-empty is-compact">{emptyText ?? t("Keine Daten.")}</div>

  const shown = limit ? items.slice(0, limit) : items
  const top = max ?? Math.max(...items.map((item) => item.value), 0)
  const total = items.reduce((sum, item) => sum + item.value, 0)

  return (
    <ul className="viz-bars">
      {shown.map((item) => {
        const width = top > 0 ? Math.max(0, Math.min(100, (item.value / top) * 100)) : 0
        const body = (
          <>
            <span className="viz-bars__head">
              <span className="viz-bars__label">
                {item.icon && <span className="viz-bars__icon">{item.icon}</span>}
                <span className="viz-bars__name" title={item.title}>{item.label}</span>
              </span>
              <span className="viz-bars__value">
                {format(item.value)}
                {share && total > 0 && <span className="viz-bars__share">{formatShare(item.value / total, locale)}</span>}
              </span>
            </span>
            {item.detail && <span className="viz-bars__detail">{item.detail}</span>}
            <span className="viz-bars__track" aria-hidden="true">
              <span
                className="viz-bars__fill"
                style={{ width: `${width}%`, background: item.color ?? "var(--accent)" }}
              />
            </span>
          </>
        )
        return (
          <li key={item.key} className="viz-bars__item">
            {onSelect ? (
              <button type="button" className="viz-bars__row is-clickable" onClick={() => onSelect(item.key)}>
                {body}
              </button>
            ) : (
              <div className="viz-bars__row">{body}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export default BarList
