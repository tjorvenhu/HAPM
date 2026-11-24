"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"

/** Abstand zum Rand des Fensters und zum Element. */
const EDGE = 8
const GAP = 8

interface Shown {
  text: string
  anchor: DOMRect
  side: "top" | "left"
  wide: boolean
}

/**
 * Zeigt jedes `data-tooltip` der Seite in einer eigenen Ebene über allem.
 *
 * Die Tooltips aus reinem CSS (`[data-tooltip]::before`) stehen mittig über
 * ihrem Element und wissen nichts vom Rand: ein langer Satz am linken Rand der
 * Seite oder in einem Container mit `overflow` war halb abgeschnitten. Diese
 * Ebene misst, bleibt im Fenster und klappt unter das Element, wenn darüber
 * kein Platz ist. Sie hängt die Klasse `has-tooltip-layer` an `<html>`: das
 * schaltet die CSS-Fassung ab, die ohne JavaScript weiter gilt.
 *
 * Gelesen wird beim Zeigen, nicht beim Rendern: `data-tooltip` ändert sich mit
 * dem Zustand der Seite, und die Ebene braucht kein Wissen über die Komponenten.
 */
export function TooltipLayer() {
  const [shown, setShown] = useState<Shown | null>(null)
  const [mounted, setMounted] = useState(false)
  const anchorRef = useRef<HTMLElement | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [place, setPlace] = useState<{ left: number; top: number; arrow: number; where: "top" | "below" | "left" } | null>(null)

  useEffect(() => {
    setMounted(true)
    document.documentElement.classList.add("has-tooltip-layer")

    const open = (target: EventTarget | null) => {
      const el = target instanceof Element ? (target.closest("[data-tooltip]") as HTMLElement | null) : null
      if (!el) return false
      const text = el.getAttribute("data-tooltip")?.replace(/\s+/g, " ").trim()
      if (!text) return false
      anchorRef.current = el
      setPlace(null)
      setShown({
        text,
        anchor: el.getBoundingClientRect(),
        side: el.getAttribute("data-tooltip-pos") === "left" ? "left" : "top",
        wide: el.classList.contains("info-hint"),
      })
      return true
    }
    const close = () => {
      anchorRef.current = null
      setShown(null)
    }

    const onOver = (event: PointerEvent) => {
      if (event.pointerType === "touch") return
      const el = event.target instanceof Element ? event.target.closest("[data-tooltip]") : null
      if (el === anchorRef.current) return
      if (!open(event.target)) close()
    }
    const onFocus = (event: FocusEvent) => {
      // Nur das „i" öffnet beim Antippen und per Tastatur, wie bisher im CSS.
      const el = event.target instanceof Element ? event.target.closest(".info-hint[data-tooltip]") : null
      if (el) open(el)
    }
    const onBlur = (event: FocusEvent) => {
      if (event.target === anchorRef.current) close()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close()
    }

    document.addEventListener("pointerover", onOver)
    document.addEventListener("focusin", onFocus)
    document.addEventListener("focusout", onBlur)
    document.addEventListener("keydown", onKey)
    window.addEventListener("scroll", close, true)
    window.addEventListener("resize", close)
    return () => {
      document.documentElement.classList.remove("has-tooltip-layer")
      document.removeEventListener("pointerover", onOver)
      document.removeEventListener("focusin", onFocus)
      document.removeEventListener("focusout", onBlur)
      document.removeEventListener("keydown", onKey)
      window.removeEventListener("scroll", close, true)
      window.removeEventListener("resize", close)
    }
  }, [])

  // Ein Element, das verschwindet (Dialog zu, Seite gewechselt), nimmt seinen Tooltip mit.
  useEffect(() => {
    if (!shown) return
    const timer = window.setInterval(() => {
      if (!anchorRef.current?.isConnected) {
        anchorRef.current = null
        setShown(null)
      }
    }, 300)
    return () => window.clearInterval(timer)
  }, [shown])

  useLayoutEffect(() => {
    const box = boxRef.current
    if (!shown || !box) return
    const { width, height } = box.getBoundingClientRect()
    const a = shown.anchor
    const maxLeft = window.innerWidth - EDGE - width

    if (shown.side === "left" && a.left - GAP - width >= EDGE) {
      const top = Math.min(Math.max(a.top + a.height / 2 - height / 2, EDGE), window.innerHeight - EDGE - height)
      setPlace({ left: a.left - GAP - width, top, arrow: a.top + a.height / 2 - top, where: "left" })
      return
    }

    const center = a.left + a.width / 2
    const left = Math.min(Math.max(center - width / 2, EDGE), Math.max(maxLeft, EDGE))
    const below = a.top - GAP - height < EDGE
    const top = below ? a.bottom + GAP : a.top - GAP - height
    setPlace({ left, top, arrow: Math.min(Math.max(center - left, 12), width - 12), where: below ? "below" : "top" })
  }, [shown])

  if (!mounted || !shown) return null
  return createPortal(
    <div
      ref={boxRef}
      role="tooltip"
      className={`tooltip-layer${shown.wide ? " is-wide" : ""}${place?.where === "below" ? " is-below" : ""}${place?.where === "left" ? " is-left" : ""}`}
      style={{
        left: place?.left ?? -9999,
        top: place?.top ?? -9999,
        ["--tooltip-arrow" as string]: `${place?.arrow ?? 0}px`,
        visibility: place ? "visible" : "hidden",
      }}
    >
      {shown.text}
    </div>,
    document.body
  )
}

export default TooltipLayer
