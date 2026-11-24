import type { ReactNode } from "react"

/**
 * Fortschritt als Ring, mit Beschriftung in der Mitte („3/5", „60 %"). Für einen Wert
 * zwischen 0 und `max`, nicht für Teile eines Ganzen (dafür `DonutChart`).
 *
 * Kein recharts: ein Kreis mit `stroke-dasharray`, der sich beim Erscheinen einzeichnet
 * (fällt bei `prefers-reduced-motion` weg).
 */
export function ProgressRing({
  value,
  max = 100,
  size = 56,
  label,
  tone = "accent",
  ariaLabel,
}: {
  value: number
  max?: number
  size?: number
  /** In der Mitte. Vorgabe: der Anteil in Prozent. */
  label?: ReactNode
  tone?: "accent" | "success" | "warning" | "danger"
  ariaLabel?: string
}) {
  const share = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0
  const percent = Math.round(share * 100)
  return (
    <div
      className={`viz-ring viz-ring--${tone}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={ariaLabel ?? `${percent} %`}
    >
      <svg viewBox="0 0 36 36" className="viz-ring__svg" aria-hidden="true">
        <circle className="viz-ring__track" cx="18" cy="18" r="15.9155" />
        {share > 0 && (
          <circle
            className="viz-ring__fill"
            cx="18"
            cy="18"
            r="15.9155"
            pathLength={100}
            strokeDasharray={`${share * 100} 100`}
          />
        )}
      </svg>
      <span className="viz-ring__label">{label ?? `${percent} %`}</span>
    </div>
  )
}

export default ProgressRing
