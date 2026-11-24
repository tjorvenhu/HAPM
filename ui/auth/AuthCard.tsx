import type { ReactNode } from "react"
import { Logo } from "../primitives/Logo"
import { LanguageSwitch } from "./LanguageSwitch"
import { UI_LOCALE_FIXED } from "@/lib/i18n/locale"

interface AuthCardProps {
  /** Überschrift der Karte, etwa „Anmelden" oder „Konto einrichten". */
  title: string
  subtitle?: ReactNode
  /** Zusätzliche Klasse an der Seite. */
  className?: string
  /**
   * Die Anmeldeseiten stehen außerhalb des Rahmens (`.app-shell`) und brauchen
   * dessen Werte am Dokument: `shell-page`. Ohne die Klasse gelten die Werte von
   * `:root`, und die Karte sieht anders aus als die Oberfläche dahinter.
   */
  standalone?: boolean
  /** Leer für den Platzhalter, solange die Seite lädt. */
  children?: ReactNode
  /** Der Umschalter der Sprache unter dem Inhalt. Vorgabe: an. */
  languageSwitch?: boolean
}

/**
 * Die Karte der Anmeldeseiten: Logo, Überschrift, Unterzeile, darunter das Formular.
 * Dieselbe für Anmeldung, Einrichtung und „Passwort vergessen".
 *
 * Das Formular darin baut die Seite aus den Klassen `.auth-form`, `.auth-field`,
 * `.auth-submit`, `.auth-error`, `.auth-success`, `.auth-hint`, `.auth-forgot`,
 * `.auth-footer` und `.auth-link`, dazu `auth/PasskeyLoginButton`.
 */
export function AuthCard({ title, subtitle, className, standalone = false, children, languageSwitch = true }: AuthCardProps) {
  const classes = ["auth-page", className, standalone ? "shell-page" : null].filter(Boolean).join(" ")
  return (
    <div className={classes}>
      <div className="auth-card">
        <div className="auth-logo">
          <Logo width={200} />
        </div>
        {title && <h1 className="auth-title">{title}</h1>}
        {subtitle && <p className="auth-subtitle">{subtitle}</p>}
        {children}
        {languageSwitch && !UI_LOCALE_FIXED && <LanguageSwitch />}
      </div>
    </div>
  )
}

export default AuthCard
