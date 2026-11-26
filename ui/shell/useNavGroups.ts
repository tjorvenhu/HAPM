import { useSyncExternalStore } from "react"

/**
 * Welche Gruppen der Seitenleiste zugeklappt sind.
 *
 * Zwei Speicher, weil es zwei Fragen sind. Welche Gruppen zu sind, ist eine
 * Vorliebe am Arbeitsplatz und gilt für den Browser (`localStorage`, wie die
 * Anordnung der Übersicht). Dass jemand die Gruppe der Seite zugeklappt hat, auf
 * der er gerade steht, gilt nur für diesen Tab und nur bis zum nächsten
 * Seitenwechsel (`sessionStorage`): im `localStorage` höbe es jeder andere Tab
 * mit seinem nächsten Seitenwechsel auf, und ganz ohne Speicher klappte ein
 * Neuladen die Gruppe wieder auf.
 *
 * Gelesen wird über `useSyncExternalStore`: Server und Hydration kennen keinen
 * Speicher und zeigen alles offen, ein `useState` mit dem gespeicherten Stand
 * wäre dort ein Hydration-Fehler. Die Leiste entsteht erst im Browser, nach dem
 * Laden der Sitzung (`ToolShell`): dort gilt der gespeicherte Stand ab dem
 * ersten Bild, ohne Sprung.
 */
const GROUPS_KEY = "hapm-sidebar-groups-v1"
const HELD_KEY = "hapm-sidebar-held-v1"

type StorageName = "localStorage" | "sessionStorage"

export interface NavGroupState {
  /** Schlüssel der zugeklappten Gruppen. */
  collapsed: readonly string[]
  /** Die aktive Seite, auf der ihre Gruppe von Hand zugeklappt wurde. */
  held: string | null
}

const EMPTY: NavGroupState = { collapsed: [], held: null }

const listeners = new Set<() => void>()

// Ohne Speicher (gesperrt oder voll) gilt der Stand bis zum Neuladen.
const unsaved = new Map<string, string>()

function read(storage: StorageName, key: string): string {
  const kept = unsaved.get(key)
  if (kept !== undefined) return kept
  try {
    return window[storage].getItem(key) ?? ""
  } catch {
    return ""
  }
}

function write(storage: StorageName, key: string, value: string): void {
  try {
    if (value) window[storage].setItem(key, value)
    else window[storage].removeItem(key)
    unsaved.delete(key)
  } catch {
    unsaved.set(key, value)
  }
}

function parseGroups(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw || "[]")
    return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : []
  } catch {
    return []
  }
}

// `useSyncExternalStore` verlangt dasselbe Objekt, solange sich nichts geändert hat.
let cache: { raw: string; state: NavGroupState } = { raw: "\n", state: EMPTY }

export function readNavGroups(): NavGroupState {
  const groups = read("localStorage", GROUPS_KEY)
  const held = read("sessionStorage", HELD_KEY)
  const raw = `${held}\n${groups}`
  if (raw !== cache.raw) cache = { raw, state: { collapsed: parseGroups(groups), held: held || null } }
  return cache.state
}

function save(next: NavGroupState): void {
  write("localStorage", GROUPS_KEY, next.collapsed.length > 0 ? JSON.stringify(next.collapsed) : "")
  write("sessionStorage", HELD_KEY, next.held ?? "")
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // Ein anderer Tab hat eine Gruppe auf- oder zugeklappt.
  window.addEventListener("storage", listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", listener)
  }
}

export function useNavGroups(): NavGroupState {
  return useSyncExternalStore(subscribe, readNavGroups, () => EMPTY)
}

/**
 * Ob eine Gruppe zu ist. Die Gruppe der aktiven Seite ist offen, auch wenn sie
 * als zugeklappt gemerkt ist (ein anderer Tab hat sie gerade zugeklappt, oder
 * der Seitenwechsel ist noch nicht gemerkt). Zu ist sie nur, wenn sie auf genau
 * dieser Seite von Hand zugeklappt wurde.
 */
export function navGroupClosed(
  state: NavGroupState,
  group: string,
  activeGroup: string | null,
  activeHref: string | null
): boolean {
  if (!state.collapsed.includes(group)) return false
  return group !== activeGroup || state.held === activeHref
}

/**
 * Klappt eine Gruppe auf oder zu. `activeHref` ist die aktive Seite, wenn sie in
 * dieser Gruppe liegt: nur dann merkt sich der Tab, dass die Gruppe trotz der
 * aktiven Seite zu bleiben soll.
 */
export function setNavGroupClosed(group: string, closed: boolean, activeHref: string | null): void {
  const now = readNavGroups()
  const others = now.collapsed.filter((key) => key !== group)
  save({
    collapsed: closed ? [...others, group] : others,
    held: activeHref === null ? now.held : closed ? activeHref : null,
  })
}

/**
 * Ein Seitenwechsel (auch der erste Aufruf): die Gruppe der neuen Seite klappt
 * auf und bleibt es. Ausnahme ist das Neuladen genau der Seite, auf der die
 * Gruppe von Hand zugeklappt wurde.
 */
export function openNavGroupOf(group: string | null, activeHref: string | null): void {
  const now = readNavGroups()
  if (now.held !== null && now.held === activeHref) return
  const collapsed = now.collapsed.filter((key) => key !== group)
  if (collapsed.length === now.collapsed.length && now.held === null) return
  save({ collapsed, held: null })
}
