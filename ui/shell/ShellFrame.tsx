"use client"

import type { ReactNode } from "react"
import { useT } from "@/lib/i18n/react"
import { ShellContent } from "./ShellContent"

interface ShellFrameProps {
  /** Zusätzliche Klassen an der Wurzel. `app-shell` setzt der Rahmen selbst. */
  className?: string
  /** Die Seitenleiste (`ShellSidebar`) oder ihr Platzhalter. Ohne steht der Inhalt allein (Anmeldung). */
  sidebar?: ReactNode
  /** Über der Inhaltsfläche, innerhalb der Fläche (ein Hinweis, der auf jeder Seite steht). */
  banner?: ReactNode
  /** Nach dem Rahmen, außerhalb der Flächen: was über allem liegt (Suche, Fortschrittsanzeige). */
  after?: ReactNode
  children: ReactNode
}

/**
 * Der Rahmen der Oberfläche: Sprunglink, Seitenleiste, Inhaltsfläche.
 *
 * `app-shell` an der Wurzel ist der Geltungsbereich der Regeln des Rahmens. Ab
 * 1024 px scrollt nur `.app-shell__main`, und `ShellContent` merkt sich dort die
 * Position je Seite.
 */
export function ShellFrame({ className, sidebar, banner, after, children }: ShellFrameProps) {
  const { t } = useT()
  return (
    <div className={className ? `${className} app-shell` : "app-shell"}>
      <a href="#main" className="app-shell__skip">
        {t("Zum Inhalt springen")}
      </a>
      {sidebar}
      <div className="app-shell__panel">
        {banner}
        <main id="main" tabIndex={-1} className="app-shell__main">
          <ShellContent>{children}</ShellContent>
        </main>
      </div>
      {after}
    </div>
  )
}

/** Platzhalter in den Maßen der Seitenleiste, damit die Inhaltsfläche beim Laden nicht springt. */
export function ShellSidebarSkeleton({ rows = 5, badge = false }: { rows?: number; badge?: boolean }) {
  return (
    <aside className="app-shell__sidebar" aria-hidden="true">
      <div className="shell-sidebar">
        <div className="shell-sidebar__header">
          <div className="skeleton shell-skeleton shell-skeleton--logo" />
          {badge && <div className="skeleton shell-skeleton shell-skeleton--pill" />}
        </div>
        <div className="shell-sidebar__content">
          <div className="shell-skeleton__stack">
            {Array.from({ length: rows }, (_, i) => (
              <div key={i} className="skeleton shell-skeleton shell-skeleton--row" />
            ))}
          </div>
        </div>
      </div>
    </aside>
  )
}

/** Platzhalter für die Inhaltsfläche: Titel und drei Flächen. Für den ersten Aufbau, solange die Sitzung lädt. */
export function ShellPageSkeleton() {
  const { t } = useT()
  return (
    <div className="shell-skeleton__page" aria-busy="true" aria-label={t("Wird geladen")}>
      <div className="skeleton shell-skeleton shell-skeleton--title" />
      <div className="skeleton shell-skeleton shell-skeleton--lead" />
      <div className="skeleton shell-skeleton shell-skeleton--block" />
      <div className="skeleton shell-skeleton shell-skeleton--block" />
      <div className="skeleton shell-skeleton shell-skeleton--block shell-skeleton--short" />
    </div>
  )
}
