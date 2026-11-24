import type { ReactNode } from "react"

export interface ChartTooltipRow {
  key: string
  name: ReactNode
  value: ReactNode
  /** Farbmarke vor dem Namen. Ohne steht die Zeile ohne Marke (Zusatzangabe). */
  color?: string
}

/**
 * Der Kasten, der beim Überfahren eines Diagramms erscheint: Überschrift, eine Zeile je
 * Reihe, darunter auf Wunsch eine Summe und ein Hinweis („Klicken für Details").
 *
 * Alle Diagramme unter `ui/charts/` nutzen ihn. Eine Seite, die ein eigenes
 * recharts-Diagramm baut, gibt ihn als `content` an `<Tooltip>` und sieht damit gleich aus.
 */
export function ChartTooltipBox({
  title,
  rows,
  total,
  hint,
}: {
  title?: ReactNode
  rows: ChartTooltipRow[]
  total?: { name: ReactNode; value: ReactNode }
  hint?: ReactNode
}) {
  return (
    <div className="viz-tooltip">
      {title !== undefined && title !== null && title !== "" && <div className="viz-tooltip-time">{title}</div>}
      {rows.map((row) => (
        <div className="viz-tooltip-row" key={row.key}>
          {row.color && <span className="viz-swatch" style={{ background: row.color }} />}
          <span className="viz-tooltip-name">{row.name}</span>
          <span className="viz-tooltip-value">{row.value}</span>
        </div>
      ))}
      {total && (
        <div className="viz-tooltip-row viz-tooltip-total">
          <span className="viz-tooltip-name">{total.name}</span>
          <span className="viz-tooltip-value">{total.value}</span>
        </div>
      )}
      {hint && <div className="viz-tooltip-hint">{hint}</div>}
    </div>
  )
}

export interface ChartLegendItem {
  key: string
  name: string
  color: string
  /** Rechts in der Zeile, etwa der Anteil. Nur in der Listenform. */
  value?: ReactNode
  /** Klein hinter dem Namen, etwa ein Wertebereich. */
  detail?: ReactNode
}

/**
 * Die Legende. Ab zwei Reihen gehört sie unter jedes Diagramm: die Zuordnung darf nie
 * allein an der Farbe hängen.
 *
 * `row` setzt die Einträge nebeneinander (unter einer Kurve), `list` untereinander mit Wert
 * rechts (neben einem Ring). Mit `onSelect` werden die Einträge zu Knöpfen.
 */
export function ChartLegend({
  items,
  layout = "row",
  onSelect,
}: {
  items: ChartLegendItem[]
  layout?: "row" | "list"
  onSelect?: (key: string) => void
}) {
  return (
    <div className={layout === "list" ? "viz-legend viz-legend--list" : "viz-legend"}>
      {items.map((item) => {
        const content = (
          <>
            <span className="viz-swatch" style={{ background: item.color }} />
            <span className="viz-legend-name">
              {item.name}
              {item.detail && <span className="viz-legend-detail"> {item.detail}</span>}
            </span>
            {item.value !== undefined && <span className="viz-legend-value">{item.value}</span>}
          </>
        )
        return onSelect ? (
          <button
            type="button"
            className="viz-legend-item is-clickable"
            key={item.key}
            onClick={() => onSelect(item.key)}
          >
            {content}
          </button>
        ) : (
          <span className="viz-legend-item" key={item.key}>
            {content}
          </span>
        )
      })}
    </div>
  )
}
