import Image from "next/image"

/**
 * Das Logo von HAPM als SVG aus `public/`.
 *
 * Die Dateien liegen unter `public/hapm-logo.svg` und
 * `public/hapm-logo-white.svg`, die Vorlage unter `assets/brand/`. Dieselbe
 * Zeichnung steht als Text in `ui/static/logo.ts`: wer das Logo tauscht,
 * tauscht beide.
 */

/** Seitenverhältnis der Datei. Die Höhe folgt daraus, wenn nur die Breite kommt. */
const NATURAL_WIDTH = 1779
const NATURAL_HEIGHT = 351

const SOURCES = {
  light: "/hapm-logo.svg",
  dark: "/hapm-logo-white.svg",
} as const

export function Logo({
  background = "light",
  width = 160,
  height,
  className,
  priority = true,
}: {
  /** Worauf das Logo steht: auf dunklem Grund kommt die helle Fassung. */
  background?: "light" | "dark"
  width?: number
  height?: number
  className?: string
  priority?: boolean
}) {
  return (
    <Image
      src={SOURCES[background]}
      alt="HAPM"
      width={width}
      height={height ?? Math.round((width * NATURAL_HEIGHT) / NATURAL_WIDTH)}
      className={className}
      priority={priority}
      unoptimized
    />
  )
}

export default Logo
