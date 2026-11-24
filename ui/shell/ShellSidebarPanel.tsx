"use client"

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import Image from "next/image"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { ChevronDown, Search, type LucideIcon } from "lucide-react"

export interface ShellNavSection {
  href: string
  label: string
  /** Schlüsselanfänge der Benachrichtigungen, deren Zähler hier stehen. */
  counts?: string[]
  /** Öffnet in einem neuen Tab (fremde Adresse). */
  newTab?: boolean
}

export interface ShellNavArea {
  key: string
  /** Ziel des Eintrags. Bei `toggleOnly` unbenutzt. */
  href: string
  label: string
  icon: LucideIcon
  /** Schlüssel einer Gruppe aus `groups`. */
  group: string
  /** Unterseiten. Ein Bereich mit nur einer Seite hat keine. */
  sections?: ShellNavSection[]
  counts?: string[]
  /** Liegt außerhalb dieses Bereichs (z. B. `/docs`) und ist deshalb nie aktiv. */
  external?: boolean
  /**
   * Der Eintrag hat keine eigene Seite: ein Klick klappt nur die Unterseiten auf.
   */
  toggleOnly?: boolean
}

export interface ShellNavGroup {
  key: string
  /** Sichtbare Überschrift. Die erste Gruppe hat keine. */
  heading?: string
  /** Name der Navigation für Screenreader. */
  label: string
}

export interface ShellCount {
  key: string
  count: number
}

export interface ShellSidebarPanelProps {
  /** Wurzel des Bereichs, z. B. `/`. Nur genau diese Adresse macht den Eintrag dorthin aktiv. */
  root: string
  areas: ShellNavArea[]
  groups: ShellNavGroup[]
  /** Kennzeichnung neben dem Logo: ein Wort mit Symbol. */
  badge?: { label: string; icon: LucideIcon }
  /** Steht statt der Kennzeichnung neben dem Logo, z. B. ein Schließen-Knopf. */
  headerEnd?: ReactNode
  /** Offene Fälle je Benachrichtigungsschlüssel, für die Zähler an den Einträgen. */
  counts?: ShellCount[]
  /** Öffnet die Suche in einem Dialog. Zeigt den Knopf „Suchen". */
  onSearch?: () => void
  /** Eigenes Suchfeld an derselben Stelle. */
  search?: ReactNode
  /** Glocke, Profil und Ähnliches. Kommt vom Layout, damit es Server-Daten tragen kann. */
  footer?: ReactNode
  /**
   * Das Logo im Kopf. Ohne Angabe `/hapm-logo.svg` aus dem `public`-Ordner.
   */
  logo?: ReactNode
}

/** Eine Feder (Steifigkeit 400, Dämpfung 34) als `linear()`, passend zu 300 ms. Dieselbe wie `--shell-spring`. */
const SPRING =
  "linear(0, 0.0271, 0.0941, 0.1838, 0.2838, 0.3854, 0.483, 0.573, 0.6535, 0.7236, 0.7835, 0.8336, 0.8748, 0.908, 0.9344, 0.955, 0.9708, 0.9825, 0.9911, 0.9972, 1.0013, 1.0039, 1.0054, 1.0061, 1)"

function matches(pathname: string, href: string, root: string): boolean {
  if (href === root) return pathname === root
  return pathname === href || pathname.startsWith(`${href}/`)
}

function areaHrefs(area: ShellNavArea): string[] {
  const sections = (area.sections ?? []).map((s) => s.href)
  return area.toggleOnly ? sections : [area.href, ...sections]
}

/**
 * Die aktive Seite ist der längste passende Pfad über alle Einträge.
 *
 * `/reverse-proxy/api` passt auf „Ziele" (`/reverse-proxy`) und auf „API".
 * Der erste Treffer wäre der falsche.
 */
function activeHref(pathname: string, areas: ShellNavArea[], root: string): string | null {
  let best: string | null = null
  for (const area of areas) {
    if (area.external) continue
    for (const href of areaHrefs(area)) {
      if (matches(pathname, href, root) && (best === null || href.length > best.length)) best = href
    }
  }
  return best
}

/**
 * Inhalt der Seitenleiste: Logo, Suche, Bereiche mit aufklappbaren Unterseiten und
 * Zählern, Fuß. **Die eine Quelle für das Menü**: `ShellSidebar` zeigt sie ab 1024 px
 * als Leiste und darunter in der Schublade. Was hier steht, gilt für beide.
 */
export function ShellSidebarPanel({
  root,
  areas,
  groups,
  badge,
  headerEnd,
  counts = [],
  onSearch,
  search,
  footer,
  logo,
}: ShellSidebarPanelProps) {
  const pathname = usePathname()
  const [toggled, setToggled] = useState<Record<string, boolean>>({})

  // Bei geringer Höhe liegt der aktive Eintrag sonst unter dem Fuß der Leiste.
  const contentRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const box = contentRef.current
    const active = box?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!box || !active) return
    const frame = box.getBoundingClientRect()
    const item = active.getBoundingClientRect()
    // Eingeklappte Unterseite: sie hat keine Höhe und taugt nicht als Ziel.
    if (item.height === 0) return
    // Unten liegt ein Verlauf über der Liste, dort gilt ein Eintrag nicht als sichtbar.
    if (item.top >= frame.top && item.bottom <= frame.bottom - 24) return
    box.scrollTop += item.top - frame.top - (frame.height - item.height) / 2
  }, [pathname])

  const current = activeHref(pathname, areas, root)
  const BadgeIcon = badge?.icon
  const activeKey =
    areas.find((area) => !area.external && current !== null && areaHrefs(area).includes(current))?.key ?? null

  // Die Markierung gleitet vom alten zum neuen Bereich. Sie ist ein Kind der aktiven
  // Zeile und wandert deshalb bei jedem Umbruch der Liste von selbst mit. Animiert wird
  // nur der Wechsel: von der zuletzt gemessenen Stelle zurück auf null.
  const pillSeen = useRef<{ key: string; top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    const box = contentRef.current
    const pill = box?.querySelector<HTMLElement>(".shell-nav__pill")
    if (!box || !pill || activeKey === null) {
      pillSeen.current = null
      return
    }
    const frame = box.getBoundingClientRect()
    const rect = pill.getBoundingClientRect()
    const now = { key: activeKey, top: rect.top - frame.top + box.scrollTop, left: rect.left - frame.left }
    const before = pillSeen.current
    pillSeen.current = now
    if (!before || before.key === now.key) return
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return
    const from = { transform: `translate(${before.left - now.left}px, ${before.top - now.top}px)` }
    try {
      pill.animate([from, { transform: "none" }], { duration: 300, easing: SPRING })
    } catch {
      // Ältere Browser kennen `linear()` nicht.
      pill.animate([from, { transform: "none" }], { duration: 300, easing: "cubic-bezier(0.22, 1, 0.36, 1)" })
    }
  }, [activeKey, toggled])

  function countFor(prefixes: string[] | undefined): number {
    if (!prefixes) return 0
    return counts
      .filter((item) => prefixes.some((prefix) => item.key.startsWith(prefix)))
      .reduce((sum, item) => sum + item.count, 0)
  }

  function countBadge(count: number, onActive: boolean) {
    if (count <= 0) return null
    return (
      <span className={onActive ? "shell-count shell-count--on-active" : "shell-count"}>
        <span aria-hidden="true">{count > 99 ? "99+" : count}</span>
        <span className="sr-only">{count} offen</span>
      </span>
    )
  }

  function renderArea(area: ShellNavArea) {
    const sections = area.sections ?? []
    const active = !area.external && current !== null && areaHrefs(area).includes(current)
    const expanded = sections.length > 0 && (toggled[area.key] ?? active)
    const Icon = area.icon
    const areaCount = countFor(area.counts) + sections.reduce((sum, s) => sum + countFor(s.counts), 0)
    const subnavId = `shell-subnav-${area.key}`
    const toggle = () => setToggled((prev) => ({ ...prev, [area.key]: !expanded }))
    const itemClass = [
      "shell-nav__item",
      active ? "shell-nav__item--active" : "",
      sections.length > 0 ? "shell-nav__item--parent" : "",
    ].join(" ")
    const itemBody = (
      <>
        <Icon size={18} strokeWidth={1.5} aria-hidden="true" />
        <span className="shell-nav__label">{area.label}</span>
        {!expanded && countBadge(areaCount, active)}
      </>
    )
    const toggleClass = active ? "shell-nav__toggle shell-nav__toggle--on-active" : "shell-nav__toggle"

    return (
      <li key={area.key}>
        <div className="shell-nav__row">
          {active && <span className="shell-nav__pill" aria-hidden="true" />}
          {area.toggleOnly ? (
            <>
              <button type="button" className={itemClass} aria-expanded={expanded} aria-controls={subnavId} onClick={toggle}>
                {itemBody}
              </button>
              {/* Nur Zeichen: der ganze Eintrag ist der Knopf. */}
              <span className={`${toggleClass} shell-nav__toggle--mark`} aria-hidden="true">
                <ChevronDown size={16} strokeWidth={1.5} />
              </span>
            </>
          ) : (
            <>
              <Link
                href={area.href}
                className={itemClass}
                aria-current={active && sections.length === 0 ? "page" : undefined}
              >
                {itemBody}
              </Link>
              {sections.length > 0 && (
                <button
                  type="button"
                  className={toggleClass}
                  aria-label={`Seiten im Bereich ${area.label}`}
                  aria-expanded={expanded}
                  aria-controls={subnavId}
                  onClick={toggle}
                >
                  <ChevronDown size={16} strokeWidth={1.5} aria-hidden="true" />
                </button>
              )}
            </>
          )}
        </div>
        {sections.length > 0 && (
          <div
            className={expanded ? "shell-subnav-wrap shell-subnav-wrap--open" : "shell-subnav-wrap"}
            inert={!expanded}
          >
            <div className="shell-subnav-clip">
              <ul className="shell-subnav" id={subnavId} aria-label={`Seiten im Bereich ${area.label}`}>
                {sections.map((section) => {
                  const sectionActive = section.href === current
                  return (
                    <li
                      key={section.href}
                      className={sectionActive ? "shell-subnav__entry shell-subnav__entry--active" : "shell-subnav__entry"}
                    >
                      <Link
                        href={section.href}
                        className={sectionActive ? "shell-subnav__item shell-subnav__item--active" : "shell-subnav__item"}
                        aria-current={sectionActive ? "page" : undefined}
                        {...(section.newTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                      >
                        <span className="shell-nav__label">{section.label}</span>
                        {countBadge(countFor(section.counts), false)}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </div>
          </div>
        )}
      </li>
    )
  }

  return (
    <div className="shell-sidebar">
      <div className="shell-sidebar__header">
        <Link href={root} className="shell-sidebar__logo">
          {logo ?? <Image src="/hapm-logo.svg" alt="HAPM" width={132} height={26} priority />}
        </Link>
        {badge && BadgeIcon && (
          <p className="shell-sidebar__area">
            <BadgeIcon size={16} strokeWidth={1.5} aria-hidden="true" />
            {badge.label}
          </p>
        )}
        {headerEnd && <div className="shell-sidebar__end">{headerEnd}</div>}
        {onSearch && (
          <button type="button" className="shell-search" onClick={onSearch}>
            <Search size={16} strokeWidth={1.5} aria-hidden="true" />
            <span className="shell-search__label">Suchen</span>
            <kbd className="shell-search__kbd">Strg K</kbd>
          </button>
        )}
        {search}
      </div>

      <div className="shell-sidebar__content" ref={contentRef}>
        {groups.map((group) => (
          <nav key={group.key} className="shell-nav" aria-label={group.label}>
            {group.heading && (
              <p className="shell-nav__heading" aria-hidden="true">
                {group.heading}
              </p>
            )}
            <ul className="shell-nav__list">{areas.filter((area) => area.group === group.key).map(renderArea)}</ul>
          </nav>
        ))}
      </div>

      {footer && <div className="shell-sidebar__footer">{footer}</div>}
    </div>
  )
}
