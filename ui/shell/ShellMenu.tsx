"use client"

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { usePresence } from "./usePresence"

interface Props {
  /** Inhalt des Auslösers (Icon, Text, Zähler). */
  trigger: ReactNode
  triggerClassName: string
  /** Zugänglicher Name des Auslösers, wenn sein Inhalt allein nicht reicht. */
  ariaLabel?: string
  /** Breite Fläche für Listen mit längeren Texten (Benachrichtigungen). */
  wide?: boolean
  /** Die Einträge. `close` schließt das Menü, etwa nach einer Auswahl. */
  children: (close: () => void) => ReactNode
}

/**
 * Menü, das über seinem Auslöser aufklappt: für den Fuß der Seitenleiste.
 *
 * Nach oben, weil der Auslöser am unteren Rand steht. Die Fläche ist absolut
 * am Auslöser verankert und nicht in den `body` gehängt: die Seitenleiste
 * schneidet nichts ab, und so bleibt das Menü in der Tab-Reihenfolge direkt
 * hinter seinem Knopf.
 */
export function ShellMenu({ trigger, triggerClassName, ariaLabel, wide = false, children }: Props) {
  const [open, setOpen] = useState(false)
  const { mounted, closing } = usePresence(open)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  function items(): HTMLElement[] {
    return Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']:not([disabled])") ?? [])
  }

  function onPanelKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const list = items()
    if (list.length === 0) return
    const index = list.indexOf(document.activeElement as HTMLElement)
    let next: number | null = null
    if (event.key === "ArrowDown") next = (index + 1) % list.length
    else if (event.key === "ArrowUp") next = (index - 1 + list.length) % list.length
    else if (event.key === "Home") next = 0
    else if (event.key === "End") next = list.length - 1
    if (next === null) return
    event.preventDefault()
    list[next]?.focus()
  }

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
    event.preventDefault()
    setOpen(true)
    // Die Einträge stehen erst nach dem Rendern im Baum.
    requestAnimationFrame(() => {
      const list = items()
      list[event.key === "ArrowUp" ? list.length - 1 : 0]?.focus()
    })
  }

  return (
    <div className="shell-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={onTriggerKeyDown}
      >
        {trigger}
      </button>
      {mounted && (
        <div
          id={panelId}
          role="menu"
          className={[
            "shell-menu__panel",
            wide ? "shell-menu__panel--wide" : "",
            closing ? "is-closing" : "",
          ].join(" ")}
          inert={closing}
          onKeyDown={onPanelKeyDown}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}
