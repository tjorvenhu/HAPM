"use client"

import type { ReactNode } from "react"
import { EllipsisVertical, LogOut } from "lucide-react"
import { useT } from "@/lib/i18n/react"
import { ShellMenu } from "./ShellMenu"

interface Props {
  name: string
  /** Darf leer sein: dann steht nur der Name da. */
  email: string
  /** Einträge über „Abmelden". `close` schließt das Menü nach einer Auswahl. */
  children?: (close: () => void) => ReactNode
  /**
   * Abmelden als Server-Action (Next): der Knopf steht dann in einem Formular
   * und funktioniert auch ohne JavaScript.
   */
  logoutAction?: (formData: FormData) => void | Promise<void>
  /** Abmelden per Aufruf an eine API-Route. So macht es HAPM. */
  onLogout?: () => void
}

/** Höchstens zwei Buchstaben: Vor- und Nachname, sonst der Anfang der Adresse. */
function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean)
  const first = parts[0]
  const last = parts[parts.length - 1]
  if (parts.length >= 2 && first && last) return ((first[0] ?? "") + (last[0] ?? "")).toUpperCase()
  return value.slice(0, 2).toUpperCase()
}

/**
 * Profil im Fuß der Seitenleiste: Name und Adresse öffnen das Menü. Abmelden
 * steht immer darin, die übrigen Einträge gibt der Bereich herein.
 */
export function ShellProfileMenu({ name, email, children, logoutAction, onLogout }: Props) {
  const { t } = useT()
  const displayName = name || email
  const logoutButton = (
    <button type={logoutAction ? "submit" : "button"} role="menuitem" className="shell-menu__item" onClick={logoutAction ? undefined : onLogout}>
      <LogOut size={16} strokeWidth={1.5} aria-hidden="true" />
      {t("Abmelden")}
    </button>
  )

  return (
    <div className="shell-profile">
      <ShellMenu
        triggerClassName="shell-profile__btn"
        trigger={
          <>
            <span className="shell-avatar" aria-hidden="true">{initials(displayName)}</span>
            <span className="shell-profile__text">
              <span className="shell-profile__name">{displayName}</span>
              {name && email && <span className="shell-profile__mail">{email}</span>}
            </span>
            <EllipsisVertical size={16} strokeWidth={1.5} aria-hidden="true" className="shell-profile__more" />
          </>
        }
      >
        {(close) => (
          <>
            <p className="shell-menu__label">
              <span className="shell-menu__label-strong">{displayName}</span>
              {name && email && <span>{email}</span>}
            </p>
            <div className="shell-menu__sep" />
            {children && (
              <>
                {children(close)}
                <div className="shell-menu__sep" />
              </>
            )}
            {logoutAction ? <form action={logoutAction}>{logoutButton}</form> : logoutButton}
          </>
        )}
      </ShellMenu>
    </div>
  )
}
