"use client"

import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react"
import { usePathname } from "next/navigation"

/**
 * Inhaltsfläche des App-Rahmens. Beim Wechsel der Seite blendet der neue Inhalt
 * mit kleinem Versatz ein, Seitenleiste und Kopfzeile bleiben stehen.
 *
 * Beim ersten Laden spielt dieselbe Bewegung als CSS-Animation (`shell-page-in`).
 * Danach löst sie der Pfad aus: Filter und Reiter in der Adresse (`?tab=`) sind kein
 * Seitenwechsel und bewegen nichts. Kein `key` auf dem Pfad, sonst verlören
 * verschachtelte Layouts bei jedem Klick ihren Zustand.
 *
 * Ab 1024 px scrollt nicht die Seite, sondern `.app-shell__main`. Der Browser
 * merkt sich nur die Position der Seite, deshalb macht es diese Komponente:
 * eine neue Seite beginnt oben, „Zurück“ landet dort, wo man war.
 */
export function ShellContent({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const ref = useRef<HTMLDivElement>(null)
  const seen = useRef(pathname)
  const positions = useRef(new Map<string, number>())
  const traversedTo = useRef<string | null>(null)

  useEffect(() => {
    const scroller = ref.current?.closest<HTMLElement>(".app-shell__main")
    if (!scroller) return

    const remember = () => positions.current.set(seen.current, scroller.scrollTop)
    const onTraverse = () => {
      traversedTo.current = window.location.pathname
    }
    scroller.addEventListener("scroll", remember, { passive: true })
    window.addEventListener("popstate", onTraverse)
    return () => {
      scroller.removeEventListener("scroll", remember)
      window.removeEventListener("popstate", onTraverse)
    }
  }, [])

  useLayoutEffect(() => {
    if (seen.current === pathname) return
    seen.current = pathname

    const back = traversedTo.current === pathname
    traversedTo.current = null
    const scroller = ref.current?.closest<HTMLElement>(".app-shell__main")
    // Mit Sprungmarke hat Next schon dorthin gescrollt.
    if (scroller && (back || !window.location.hash)) {
      scroller.scrollTop = back ? (positions.current.get(pathname) ?? 0) : 0
    }

    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return
    ref.current?.animate(
      [{ opacity: 0, transform: "translateY(0.5rem)" }, { opacity: 1, transform: "none" }],
      { duration: 200, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    )
  }, [pathname])

  return (
    <div className="app-shell__content" ref={ref}>
      {children}
    </div>
  )
}
