"use client"

import Image from "next/image"
import { useBrand, type Brand } from "./brand"

/**
 * Das Logo, samt Pille daneben, wenn eine eingeschaltet ist.
 *
 * Ohne eigenes Logo das von HAPM als SVG aus `public/`: die Dateien liegen
 * unter `public/hapm-logo.svg` und `public/hapm-logo-white.svg`, die Vorlage
 * unter `assets/brand/`. Dieselbe Zeichnung steht als Text in
 * `ui/static/logo.ts`: wer das Logo tauscht, tauscht beide.
 *
 * Ein eigenes Logo (`brand.tsx`) hat ein Seitenverhältnis, das hier niemand
 * kennt. Es steht deshalb als `<img>` mit fester Höhe und größter Breite
 * (`.brand-logo__img` in `app/branding.css`, `object-fit: contain`).
 */

/** Seitenverhältnis der Datei. Die Höhe folgt daraus, wenn nur die Breite kommt. */
const NATURAL_WIDTH = 1779
const NATURAL_HEIGHT = 351

/**
 * Höhe eines eigenen Logos im Verhältnis zur Breite, die der Platz vorgibt. Ein
 * Logo im Querformat 4:1 füllt die Breite fast, ein quadratisches steht als
 * Zeichen in Höhe einer Zeile.
 */
const CUSTOM_HEIGHT_SHARE = 0.28

const SOURCES = {
  light: "/hapm-logo.svg",
  dark: "/hapm-logo-white.svg",
} as const

interface LogoProps {
  /** Worauf das Logo steht: auf dunklem Grund kommt die helle Fassung. */
  background?: "light" | "dark"
  width?: number
  height?: number
  className?: string
  priority?: boolean
  /** Die Pille daneben zeigen, wenn eine eingeschaltet ist. Vorgabe: ja. */
  pill?: boolean
  /** Statt des eingestellten Aussehens, etwa für eine Vorschau. */
  brand?: Brand
}

export function Logo({ background = "light", width = 160, height, className, priority = true, pill = true, brand }: LogoProps) {
  const context = useBrand()
  const current = brand ?? context
  const name = current.name ?? "HAPM"
  const custom = background === "dark" ? (current.logoDark ?? current.logo) : current.logo
  const naturalHeight = height ?? Math.round((width * NATURAL_HEIGHT) / NATURAL_WIDTH)

  const image = custom ? (
    // Kein `next/image`: das verlangt eine feste Größe, und das Seitenverhältnis ist unbekannt.
    <img
      src={custom}
      alt={name}
      className={["brand-logo__img", className].filter(Boolean).join(" ")}
      // Feste Höhe, Breite aus dem Seitenverhältnis: ein SVG ohne eigene Maße hätte sonst keine Breite.
      style={{ height: height ?? Math.round(width * CUSTOM_HEIGHT_SHARE), maxWidth: width }}
    />
  ) : (
    <Image
      src={SOURCES[background]}
      alt={name}
      width={width}
      height={naturalHeight}
      className={className}
      priority={priority}
      unoptimized
    />
  )

  if (!pill || !current.pill) return image
  return (
    <span className="brand-logo">
      {image}
      <span className="brand-pill">{current.pill}</span>
    </span>
  )
}

export default Logo
