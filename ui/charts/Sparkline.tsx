import { useId } from "react"

/**
 * Eine Verlaufslinie ohne Achsen, für eine Kennzahl-Kachel. Die Zahl steht in der Kachel,
 * die Linie zeigt nur die Richtung. Deshalb `aria-hidden` und kein Tooltip.
 *
 * Kein recharts: zwanzig bis sechzig Punkte in einer Kachel, die alle paar Sekunden neu
 * rendert, sind ein `path` und keine Diagrammbibliothek.
 *
 * `null` ist eine Lücke und keine Null: die Linie setzt ab und dort wieder an, wo es wieder
 * einen Wert gibt. Liegen weniger als zwei Werte vor, bleibt die Fläche leer und hält ihre
 * Höhe, damit die Kachel beim ersten Wert nicht springt.
 */
export function Sparkline({
  points,
  from,
  to,
  height = 28,
  tone = "accent",
  min = 0,
}: {
  points: { t: number; value: number | null }[]
  /** Der Zeitraum, den die Breite darstellt. Ein fehlender Abschnitt bleibt so als Lücke sichtbar. */
  from: number
  to: number
  height?: number
  tone?: "accent" | "warning" | "danger"
  /** Untergrenze der Höhe. Raten fangen bei 0 an, damit ein Zittern nicht wie ein Absturz aussieht. */
  min?: number
}) {
  const id = useId()
  const known = points.filter((point): point is { t: number; value: number } => point.value !== null)
  const span = to - from

  if (known.length < 2 || span <= 0) {
    return <div className={`viz-spark viz-spark--${tone}`} style={{ height }} aria-hidden="true" />
  }

  const max = Math.max(...known.map((point) => point.value))
  const low = Math.min(min, ...known.map((point) => point.value))
  const range = max - low
  const W = 100
  const H = height
  // Ein Pixel Rand oben und unten: sonst schneidet der Strich an der Kante ab.
  const x = (t: number) => ((t - from) / span) * W
  const y = (value: number) => (range === 0 ? H - 1 : H - 1 - ((value - low) / range) * (H - 2))

  const segments: { t: number; value: number }[][] = []
  let current: { t: number; value: number }[] = []
  for (const point of points) {
    if (point.value === null) {
      if (current.length) segments.push(current)
      current = []
    } else {
      current.push({ t: point.t, value: point.value })
    }
  }
  if (current.length) segments.push(current)

  const line = (segment: { t: number; value: number }[]) =>
    segment.map((point, i) => `${i ? "L" : "M"}${x(point.t).toFixed(2)},${y(point.value).toFixed(2)}`).join("")

  return (
    <div className={`viz-spark viz-spark--${tone}`} style={{ height }} aria-hidden="true">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="viz-spark__svg">
        <defs>
          <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className="viz-spark__stop" stopOpacity={0.24} />
            <stop offset="100%" className="viz-spark__stop" stopOpacity={0} />
          </linearGradient>
        </defs>
        {segments.map((segment, i) =>
          segment.length > 1 ? (
            <g key={i}>
              <path
                className="viz-spark__area"
                d={`${line(segment)}L${x(segment[segment.length - 1].t).toFixed(2)},${H}L${x(segment[0].t).toFixed(2)},${H}Z`}
                fill={`url(#${id}-fill)`}
              />
              <path className="viz-spark__line" d={line(segment)} />
            </g>
          ) : (
            <circle key={i} className="viz-spark__dot" cx={x(segment[0].t)} cy={y(segment[0].value)} r={1} />
          )
        )}
      </svg>
    </div>
  )
}

export default Sparkline
