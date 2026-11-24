/**
 * Farben und Formate der Diagramme.
 *
 * Die Werte stehen als CSS-Variablen in `css/charts.css` (`--viz-1` bis `--viz-8`),
 * damit hier kein Hex-Wert steht und die Palette an einer Stelle liegt.
 */

/**
 * Die kategoriale Palette in fester Reihenfolge: eine Farbe je Reihe, nicht je Zustand.
 *
 * Die Reihenfolge ist der Mechanismus, nicht die Auswahl: benachbarte Plätze sind gegen
 * Rot-Grün- und Blau-Gelb-Schwäche geprüft. Nicht umsortieren und keine neunte Farbe
 * erfinden, sondern `seriesColor()` nehmen.
 */
export const VIZ_COLORS = [
  "var(--viz-1)",
  "var(--viz-2)",
  "var(--viz-3)",
  "var(--viz-4)",
  "var(--viz-5)",
  "var(--viz-6)",
  "var(--viz-7)",
  "var(--viz-8)",
] as const

/**
 * Ab der neunten Reihe derselbe Platz in einer helleren und einer dunkleren Stufe, in
 * oklab gemischt, damit die Buntheit bleibt. 72 % Grundton: bei weniger wurden die Stufen
 * zu Pastelltönen, und ein Stapel aus zwanzig Bändern las sich als Verlauf.
 */
const SHADES = [
  (color: string) => color,
  (color: string) => `color-mix(in oklab, ${color} 72%, var(--viz-tint))`,
  (color: string) => `color-mix(in oklab, ${color} 72%, var(--viz-shade))`,
] as const

/** Wie viele Reihen unterscheidbare Farben bekommen, bevor es von vorn anfängt. */
export const DISTINCT_SERIES = VIZ_COLORS.length * SHADES.length

/** Die Farbe der i-ten Reihe. Für i < 8 die reine Palette. */
export function seriesColor(index: number): string {
  const base = VIZ_COLORS[index % VIZ_COLORS.length] ?? VIZ_COLORS[0]
  const shade = SHADES[Math.floor(index / VIZ_COLORS.length) % SHADES.length] ?? SHADES[0]
  return shade(base)
}

/**
 * Zustand statt Reihe: gut, Warnung, Fehler. Für Referenzlinien und für Diagramme, deren
 * Teile Zustände sind (Sprachqualität, Statusklassen). Nie als „Reihe 4" verwenden, und
 * immer mit Wort daneben: eine Farbe allein ist keine Auskunft.
 */
export type ChartTone = "accent" | "success" | "warning" | "danger" | "muted"

export const TONE_COLOR: Record<ChartTone, string> = {
  accent: "var(--accent)",
  success: "var(--success)",
  warning: "var(--warning)",
  danger: "var(--danger)",
  muted: "var(--text-tertiary)",
}

/** Beschriftung der Achsen: klein und zurückhaltend, die Kurve ist die Aussage. */
export const AXIS_TICK = { fontSize: 11, fill: "var(--text-tertiary)" } as const

/** Was dasteht, wenn ein Wert fehlt. */
export const MISSING = "–"

const numberFormats = new Map<number, Intl.NumberFormat>()

/** Zahl mit deutschem Trennzeichen, standardmäßig ohne Nachkommastellen. */
export function formatNumber(value: number, digits = 0): string {
  let format = numberFormats.get(digits)
  if (!format) {
    format = new Intl.NumberFormat("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits })
    numberFormats.set(digits, format)
  }
  return format.format(value)
}

/** Anteil in Prozent, `0,5` wird „50 %". Unter 10 % mit einer Nachkommastelle. */
export function formatShare(share: number): string {
  const percent = share * 100
  return `${formatNumber(percent, percent > 0 && percent < 10 ? 1 : 0)} %`
}

/**
 * Achsenbeschriftung einer Zeitachse: über anderthalb Tage das Datum, darunter die Uhrzeit.
 * Die Jahreszahl steht im gewählten Zeitraum und nicht an jedem Strich.
 */
export function formatAxisTime(ms: number, rangeMs: number): string {
  const date = new Date(ms)
  if (rangeMs > 36 * 60 * 60 * 1000) {
    return date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" })
  }
  return date.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })
}

/** Zeitpunkt im Tooltip: Datum und Uhrzeit. */
export function formatTooltipTime(ms: number): string {
  return new Date(ms).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" })
}

/** Aus `2026-08-26` wird `26.08.`: die Jahreszahl steht schon im Zeitraum. */
export function formatDay(day: string): string {
  const [, month, date] = day.split("-")
  return month && date ? `${date.slice(0, 2)}.${month}.` : day
}
