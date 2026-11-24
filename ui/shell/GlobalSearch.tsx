"use client"

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react"
import { createPortal } from "react-dom"
import { useRouter } from "next/navigation"
import { Search } from "lucide-react"
import { useT } from "@/lib/i18n/react"

export interface GlobalSearchItem {
  href: string
  title: string
  subtitle?: string | null
}

export interface GlobalSearchGroup {
  label: string
  items: GlobalSearchItem[]
}

export interface GlobalSearchProps {
  /** Was sich finden lässt, als Platzhalter im Feld. */
  placeholder: string
  /**
   * Die Suche selbst (Server Action oder Abruf). Wird entprellt aufgerufen, eine
   * überholte Antwort wird verworfen. Wirft sie, gilt das als „keine Treffer".
   */
  search: (query: string) => Promise<GlobalSearchGroup[]>
  /**
   * Treffer, die der Aufrufer ohne Anfrage kennt (etwa die Seiten aus der Navigation). Sie
   * stehen sofort da, auch während `search` noch läuft, und vor dessen Gruppen.
   */
  localGroups?: (query: string) => GlobalSearchGroup[]
  /** Ab so vielen Zeichen wird gesucht. */
  minLength?: number
  /** Die Seite dahinter scrollt nicht mit, solange die Suche offen ist. */
  lockScroll?: boolean
}

// SSR-sicherer Mounted-Check ohne setState im Effekt: Server-Snapshot false,
// Client-Snapshot true, keine Subscription nötig.
const emptySubscribe = () => () => {}
function useMounted(): boolean {
  return useSyncExternalStore(emptySubscribe, () => true, () => false)
}

/**
 * Öffnen von außen: der Suchknopf sitzt in der Seitenleiste, also in einer anderen
 * Komponente. Ein gemeinsamer Zustand im Baum wäre dafür ein Context um den ganzen
 * Rahmen, nur um einen Knopf zu verdrahten.
 */
const openListeners = new Set<() => void>()

export function openGlobalSearch() {
  for (const listener of openListeners) listener()
}

/**
 * Die globale Suche: Strg K (oder Cmd K) öffnet eine Palette, Pfeiltasten wählen,
 * Enter öffnet, Escape schließt. Sie hängt am `body`, nicht im Rahmen.
 *
 * Wonach gesucht wird, gibt der Aufrufer herein. Form und Bedienung stehen hier, die
 * Regeln dazu (`.global-search*`) in `css/tool-vocabulary.css`.
 */
export default function GlobalSearch({ placeholder, search, localGroups, minLength = 2, lockScroll = false }: GlobalSearchProps) {
  const router = useRouter()
  const { t, rich } = useT()
  const mounted = useMounted()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [remote, setRemote] = useState<GlobalSearchGroup[]>([])
  const [pending, setPending] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const requestId = useRef(0)
  // Die hereingegebene Suche in einer Ref: eine neue Funktion je Renderrunde soll die
  // laufende Entprellung nicht neu starten.
  const searchRef = useRef(search)
  useEffect(() => {
    searchRef.current = search
  }, [search])
  const hasLocal = !!localGroups

  const close = useCallback(() => {
    setOpen(false)
    setQuery("")
    setRemote([])
    setPending(false)
    setActiveIndex(0)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setOpen((prev) => !prev)
      } else if (event.key === "Escape") {
        close()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [close])

  useEffect(() => {
    const show = () => setOpen(true)
    openListeners.add(show)
    return () => {
      openListeners.delete(show)
    }
  }, [])

  useEffect(() => {
    if (!open || !lockScroll) return
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = ""
    }
  }, [open, lockScroll])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const trimmed = query.trim()
  const searching = trimmed.length >= minLength

  // Entprellt: eine Anfrage je Tipp-Pause, nicht je Buchstabe. Eine überholte Antwort wird
  // verworfen, sonst überschriebe „ser" die Treffer von „server".
  useEffect(() => {
    if (!open || !searching) {
      requestId.current++
      return
    }
    const id = ++requestId.current
    const timer = setTimeout(async () => {
      setPending(true)
      try {
        const groups = await searchRef.current(trimmed)
        if (id !== requestId.current) return
        setRemote(groups)
        // Ohne eigene Treffer des Aufrufers beginnt die Liste mit jeder Antwort neu. Mit ihnen
        // stand schon etwas da, und die Markierung soll nicht unter der Hand springen.
        if (!hasLocal) setActiveIndex(0)
      } catch {
        if (id === requestId.current) setRemote([])
      } finally {
        if (id === requestId.current) setPending(false)
      }
    }, 250)
    return () => clearTimeout(timer)
  }, [open, searching, trimmed, hasLocal])

  // Unter der Mindestlänge zeigt die Liste den Hinweis: alte Treffer dürfen dann weder zu
  // sehen noch per Tastatur ansteuerbar sein.
  const local = searching && localGroups ? localGroups(trimmed) : []
  const groups: GlobalSearchGroup[] = searching ? [...local, ...remote] : []
  const flatItems = groups.flatMap((group) => group.items)
  // Die Trefferliste kann unter der Markierung kürzer werden (neue Antwort).
  const active = Math.min(activeIndex, Math.max(flatItems.length - 1, 0))

  const navigateTo = useCallback(
    (href: string) => {
      close()
      router.push(href)
    },
    [close, router]
  )

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" })
  }, [active])

  function onInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      if (flatItems.length) setActiveIndex((active + 1) % flatItems.length)
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      if (flatItems.length) setActiveIndex((active - 1 + flatItems.length) % flatItems.length)
    } else if (event.key === "Enter") {
      event.preventDefault()
      const item = flatItems[active]
      if (item) navigateTo(item.href)
    }
  }

  if (!mounted || !open) return null

  let offset = 0

  return createPortal(
    <div
      className="global-search-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div className="global-search-modal" role="dialog" aria-modal="true" aria-label={t("Globale Suche")}>
        <div className="global-search__input-row">
          <Search size={16} className="global-search__input-icon" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            className="global-search__input"
            placeholder={placeholder}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              // Mit eigenen Treffern ändert sich die Liste mit jedem Buchstaben.
              if (hasLocal) setActiveIndex(0)
            }}
            onKeyDown={onInputKeyDown}
            role="combobox"
            aria-expanded={flatItems.length > 0}
            aria-autocomplete="list"
            aria-controls="global-search-results"
            spellCheck={false}
          />
        </div>

        <div className="global-search__results" id="global-search-results" role="listbox" ref={listRef}>
          {!searching ? (
            <p className="global-search__empty">{t("Mindestens {count} Zeichen eingeben.", { count: minLength })}</p>
          ) : flatItems.length === 0 ? (
            <p className="global-search__empty">{pending ? t("Suche läuft …") : t("Keine Treffer für „{query}“.", { query: trimmed })}</p>
          ) : (
            groups.map((group) => {
              const groupOffset = offset
              offset += group.items.length
              return (
                <div className="global-search__group" key={group.label}>
                  <div className="global-search__group-label">{group.label}</div>
                  {group.items.map((item, i) => {
                    const index = groupOffset + i
                    return (
                      <button
                        type="button"
                        // Mehrere Treffer eines Bereichs können auf dieselbe Liste zeigen.
                        key={`${item.href}:${item.title}:${i}`}
                        data-index={index}
                        role="option"
                        aria-selected={index === active}
                        className={index === active ? "global-search__item global-search__item--active" : "global-search__item"}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => navigateTo(item.href)}
                      >
                        <span className="global-search__item-title">{item.title}</span>
                        {item.subtitle && <span className="global-search__item-subtitle">{item.subtitle}</span>}
                      </button>
                    )
                  })}
                </div>
              )
            })
          )}
        </div>

        <div className="global-search__footer">
          <span>
            {rich("{keys} zum Öffnen", {
              keys: (
                <>
                  <kbd className="global-search__kbd">{t("Strg")}</kbd>+<kbd className="global-search__kbd">K</kbd>
                </>
              ),
            })}
          </span>
          <span>·</span>
          <span>
            {rich("{key} zum Schließen", { key: <kbd className="global-search__kbd">Esc</kbd> })}
          </span>
        </div>
      </div>
    </div>,
    document.body
  )
}
