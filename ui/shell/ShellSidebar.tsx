"use client"

import { useEffect, useState, type MouseEvent } from "react"
import Image from "next/image"
import Link from "next/link"
import { Menu, Search, X } from "lucide-react"
import { useT } from "@/lib/i18n/react"
import { ShellSidebarPanel, type ShellSidebarPanelProps } from "./ShellSidebarPanel"

export type { ShellNavArea, ShellNavGroup, ShellNavSection, ShellCount } from "./ShellSidebarPanel"

type Props = Omit<ShellSidebarPanelProps, "headerEnd" | "search" | "badge"> & {
  /** Kennzeichnung neben dem Logo: ein Wort mit Symbol. */
  badge?: ShellSidebarPanelProps["badge"]
}

/**
 * Seitenleiste des App-Rahmens. Ab 1024 px steht sie links, darunter liegt sie in
 * einer Schublade hinter dem Menü-Knopf der Kopfzeile.
 *
 * Der Inhalt (Logo, Suche, Bereiche, Fuß) kommt aus `ShellSidebarPanel`. Der
 * Aufrufer gibt nur die Gliederung herein.
 */
export function ShellSidebar({ onSearch, ...panel }: Props) {
  const { t } = useT()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    document.body.style.overflow = "hidden"
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.body.style.overflow = ""
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  // Ein Klick auf einen Link schließt die Schublade. Kein Effekt auf `pathname`:
  // der liefe erst nach dem Seitenwechsel und setzte Zustand im Effekt.
  function closeOnLink(event: MouseEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest("a")) setOpen(false)
  }

  return (
    <>
      <header className="shell-topbar">
        <button
          type="button"
          className="shell-icon-btn"
          aria-label={open ? t("Navigation schließen") : t("Navigation öffnen")}
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
        >
          {open ? <X size={20} strokeWidth={1.5} /> : <Menu size={20} strokeWidth={1.5} />}
        </button>
        <Link href={panel.root} className="shell-topbar__logo">
          {panel.logo ?? <Image src="/hapm-logo.svg" alt="HAPM" width={132} height={26} />}
        </Link>
        {onSearch && (
          <button type="button" className="shell-icon-btn shell-topbar__search" aria-label={t("Suche öffnen")} onClick={onSearch}>
            <Search size={18} strokeWidth={1.5} />
          </button>
        )}
      </header>

      <div
        className={open ? "shell-overlay shell-overlay--open" : "shell-overlay"}
        aria-hidden="true"
        onClick={() => setOpen(false)}
      />

      <aside
        className={open ? "app-shell__sidebar app-shell__sidebar--open" : "app-shell__sidebar"}
        aria-label={t("Seitenleiste")}
        onClick={closeOnLink}
      >
        <ShellSidebarPanel
          {...panel}
          onSearch={
            onSearch
              ? () => {
                  setOpen(false)
                  onSearch()
                }
              : undefined
          }
        />
      </aside>
    </>
  )
}
