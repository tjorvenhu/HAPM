"use client"

import { Info } from "lucide-react"

interface Props {
  /** Die Erklärung. Nur Text: sie steht in einem Tooltip (`data-tooltip`). */
  text?: string
  /** Dasselbe als Inhalt des Elements, für `<InfoHint>Erklärung</InfoHint>`. */
  children?: string
  /** Der Tooltip öffnet nach links, für ein „i" am rechten Rand. */
  position?: "left"
  /**
   * Früher die Beschriftung des Knopfes. Vorleser lesen jetzt die Erklärung selbst,
   * der Wert wird nicht mehr gebraucht.
   */
  label?: string
}

/**
 * Lange Erklärung hinter einem „i" neben einer Beschriftung oder Überschrift.
 * Sichtbar bleibt ein Satz, der Rest steht im Tooltip, wenn man ihn braucht.
 *
 * Der Tooltip öffnet beim Überfahren und beim Antippen (Fokus): anders als
 * gewöhnliche Tooltips steht er auch auf schmalen Bildschirmen, denn die
 * Erklärung gibt es nur hier.
 *
 * Steht es in einem `<label>`, das einen Schalter umschließt, legt ein Klick darauf den
 * Schalter nicht um: der Klick endet am „i".
 *
 * `role="img"`, weil Vorleser ein `aria-label` an einem `span` ohne Rolle meist
 * verwerfen, und dann gäbe es die Erklärung nur für die Maus.
 */
export function InfoHint({ text, children, position }: Props) {
  const content = (text ?? children ?? "").replace(/\s+/g, " ").trim()
  return (
    <span
      className="info-hint"
      data-tooltip={content}
      data-tooltip-pos={position}
      role="img"
      aria-label={content}
      tabIndex={0}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      <Info size={14} strokeWidth={1.5} />
    </span>
  )
}
