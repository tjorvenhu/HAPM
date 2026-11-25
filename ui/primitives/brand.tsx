"use client"

import { createContext, useContext, type ReactNode } from "react"

/**
 * Das eigene Aussehen, soweit Bausteine es zeigen: Logo, helle Fassung, Pille,
 * Name. Das Wurzel-Layout liest es auf dem Server und legt es hier ab, damit
 * die erste Antwort schon das richtige Logo trägt.
 *
 * Ohne Provider gilt alles von HAPM. Die Farben kommen nicht hier durch,
 * sondern als CSS-Variablen an der Wurzel.
 */
export interface Brand {
  /** Name des Werkzeugs, etwa für den Browser-Tab. `null`: HAPM. */
  name: string | null
  /** Kurzer Text neben dem Logo. `null`: keine Pille. */
  pill: string | null
  /** Adresse des eigenen Logos. `null`: das von HAPM. */
  logo: string | null
  /** Die helle Fassung für dunkle Flächen. Fehlt sie, steht dort das Logo selbst. */
  logoDark: string | null
}

export const HAPM_BRAND: Brand = { name: null, pill: null, logo: null, logoDark: null }

const BrandContext = createContext<Brand>(HAPM_BRAND)

export function BrandProvider({ value, children }: { value: Brand; children: ReactNode }) {
  return <BrandContext.Provider value={value}>{children}</BrandContext.Provider>
}

export function useBrand(): Brand {
  return useContext(BrandContext)
}
