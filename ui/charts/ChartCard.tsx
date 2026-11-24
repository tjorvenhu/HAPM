import type { ReactNode } from "react"
import { InfoHint } from "../primitives/InfoHint"
import { splitHint } from "../primitives/hint-text"

/**
 * Die Karte um ein Diagramm: Titel, auf Wunsch ein „i" mit der Erklärung, eine kurze
 * Unterzeile und rechts eine Aktion (Zeitraum, Umschalter).
 *
 * Was ein Diagramm zeigt und wie man es liest, gehört ins `info`, nicht in die Unterzeile:
 * sichtbar bleibt ein kurzer Satz. Eine Unterzeile aus reinem Text, die länger ist
 * (`LONG_TEXT`), wandert von selbst hinter das „i". Mehrere Karten nebeneinander in
 * `.viz-grid`.
 */
export function ChartCard({
  title,
  info,
  subtitle,
  action,
  className,
  children,
}: {
  title: ReactNode
  info?: string
  subtitle?: ReactNode
  action?: ReactNode
  className?: string
  children: ReactNode
}) {
  const { visible, hint } = splitHint(subtitle)
  const explanation = [info, hint].filter(Boolean).join(" ")
  return (
    <section className={className ? `viz-card ${className}` : "viz-card"}>
      <div className="viz-card__head">
        <div className="viz-card__heading">
          <h2 className="viz-card__title">
            {title}
            {explanation && <InfoHint text={explanation} />}
          </h2>
          {visible && <p className="viz-card__subtitle">{visible}</p>}
        </div>
        {action && <div className="viz-card__action">{action}</div>}
      </div>
      {children}
    </section>
  )
}

/** Was statt eines Diagramms dasteht, wenn es nichts zu zeichnen gibt. Hält die Höhe. */
export function ChartEmpty({ children, height }: { children: ReactNode; height?: number }) {
  return (
    <div className="viz-empty" style={height ? { height } : undefined}>
      {children}
    </div>
  )
}
