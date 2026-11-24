"use client"

import { createContext, useCallback, useContext, useEffect, useState, type ReactElement, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { ShellFrame, ShellPageSkeleton, ShellSidebarSkeleton } from "../shell/ShellFrame"
import { ToastProvider } from "./Toast"
import { ConfirmProvider } from "./ConfirmDialog"

/** Was der Rahmen von einer Sitzung braucht. Weitere Felder legt `SessionData` in `lib/types.ts` fest. */
export interface ToolSession {
  csrfToken?: string
  /** Passwort stimmt, der Code fehlt noch: zurück zur Anmeldung. */
  twoFactorPending?: boolean
}

export interface ToolContextValue<S extends ToolSession> {
  session: S
  /** `fetch` mit CSRF-Token. Für jeden Aufruf an `/api`. */
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>
  /** Die Sitzung neu holen, etwa nach dem Einrichten des zweiten Faktors. */
  reload: () => Promise<void>
}

const ToolContext = createContext<ToolContextValue<ToolSession> | null>(null)

/** Sitzung und `apiFetch` innerhalb von `ToolShell`. `S` ist die Form der Sitzung beim Aufrufer. */
export function useTool<S extends ToolSession>(): ToolContextValue<S> {
  const context = useContext(ToolContext)
  if (!context) throw new Error("useTool gehört innerhalb von ToolShell")
  return context as unknown as ToolContextValue<S>
}

interface ToolShellProps<S extends ToolSession> {
  /** Liefert `{ data: S }` oder einen Fehlerstatus. Vorgabe `/api/auth/me`. */
  sessionUrl?: string
  /** Wohin ohne Sitzung. Vorgabe `/login`. */
  loginPath?: string
  /** Die Seitenleiste, mit Sitzung und Token. */
  sidebar: (context: ToolContextValue<S>) => ReactNode
  /**
   * Statt des Rahmens etwas anderes zeigen, solange es nötig ist (Einrichtung des
   * zweiten Faktors). `null` heißt: der Rahmen.
   */
  gate?: (context: ToolContextValue<S>) => ReactNode | null
  /** Was über dem Rahmen liegt (Suche, Fortschrittsanzeige). */
  after?: ReactNode
  children: ReactNode
}

/**
 * Das Gerüst der Oberfläche: holt die Sitzung, schickt ohne Sitzung
 * zur Anmeldung, stellt `apiFetch` mit CSRF-Token bereit und legt Meldungen
 * (`useToast`) und Bestätigungen (`useConfirm`) um den Rahmen.
 *
 * Solange die Sitzung lädt, steht der Rahmen als Platzhalter da, kein Text.
 */
export function ToolShell<S extends ToolSession>({
  sessionUrl = "/api/auth/me",
  loginPath = "/login",
  sidebar,
  gate,
  after,
  children,
}: ToolShellProps<S>): ReactElement | null {
  const router = useRouter()
  const [session, setSession] = useState<S | null>(null)
  // Der Token als eigener Zustand: `apiFetch` hängt nur an ihm und nicht an der ganzen
  // Sitzung, sonst entstünde die Funktion bei jeder Aktualisierung neu, und jede Seite,
  // die sie als Abhängigkeit führt, lüde neu.
  const [csrfToken, setCsrfToken] = useState("")
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const response = await fetch(sessionUrl)
    if (!response.ok) throw new Error("keine Sitzung")
    const body = await response.json()
    const data = body.data as S
    if (data.twoFactorPending) {
      router.push(loginPath)
      return
    }
    setSession(data)
    setCsrfToken(data.csrfToken ?? "")
  }, [sessionUrl, loginPath, router])

  useEffect(() => {
    load()
      .catch(() => router.push(loginPath))
      .finally(() => setLoading(false))
  }, [load, loginPath, router])

  const apiFetch = useCallback(
    async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      if (csrfToken) headers.set("X-CSRF-Token", csrfToken)
      return fetch(url, { ...init, headers })
    },
    [csrfToken]
  )

  const reload = useCallback(async () => {
    await load().catch(() => {})
  }, [load])

  if (loading) {
    return (
      <ShellFrame sidebar={<ShellSidebarSkeleton />}>
        <ShellPageSkeleton />
      </ShellFrame>
    )
  }
  if (!session) return null

  const context: ToolContextValue<S> = { session, apiFetch, reload }
  const gated = gate?.(context) ?? null
  if (gated) return <>{gated}</>

  return (
    <ToolContext.Provider value={context as unknown as ToolContextValue<ToolSession>}>
      {/* Ganz außen, damit auch ein Dialog eine Meldung absetzen kann. */}
      <ToastProvider>
        <ConfirmProvider>
          <ShellFrame sidebar={sidebar(context)} after={after}>
            {children}
          </ShellFrame>
        </ConfirmProvider>
      </ToastProvider>
    </ToolContext.Provider>
  )
}
