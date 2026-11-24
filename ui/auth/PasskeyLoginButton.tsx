"use client"

import { useState, useTransition } from "react"
import { KeyRound } from "lucide-react"
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser"

type AuthenticationOptions = Parameters<typeof startAuthentication>[0]["optionsJSON"]
type AuthenticationResponse = Awaited<ReturnType<typeof startAuthentication>>

export interface PasskeyLoginButtonProps {
  /** Holt die Aufgabe vom Server. `error` ist eine Meldung für den Nutzer. */
  requestOptions: () => Promise<{ options?: unknown; error?: string }>
  /**
   * Schickt die Antwort des Geräts zum Server. `error` ist eine Meldung für den Nutzer.
   * Darf bei Erfolg auch gar nicht zurückkommen (eine Server Action, die weiterleitet).
   */
  verify: (response: AuthenticationResponse) => Promise<{ error?: string } | void>
  /** Meldung zu einem Fehler des Browsers (`NotAllowedError`, `SecurityError` …). */
  describeBrowserError: (name: string | undefined) => string
  /** Nach der Anmeldung, wenn `verify` zurückkommt. Die Seite entscheidet, wohin es geht. */
  onSuccess?: () => void
  /**
   * Zeigt die Seite Fehler selbst an einer Stelle, bekommt sie sie hier (ein leerer Text
   * räumt ab). Ohne diese Angabe zeigt der Baustein den Fehler unter dem Knopf.
   */
  onError?: (message: string) => void
}

/**
 * „Mit Passkey anmelden" auf einer Anmeldeseite, unter dem Formular.
 *
 * Ohne E-Mail-Adresse: das Gerät bietet die Passkeys an, die es für diese Seite kennt. Die
 * Anmeldung ersetzt Passwort und zweiten Faktor in einem Schritt. Wer keinen Passkey hat,
 * meldet sich oben wie bisher an.
 *
 * Wie die Aufgabe geholt und die Antwort geprüft wird, gibt die Seite herein (Server
 * Actions oder Abrufe). Form und Ablauf stehen hier, die Regeln dazu (`.auth-passkey`,
 * `.auth-divider`) in `css/tool-vocabulary.css`.
 */
export default function PasskeyLoginButton({ requestOptions, verify, describeBrowserError, onSuccess, onError }: PasskeyLoginButtonProps) {
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  // Nach dem Erfolg bleibt der Knopf gesperrt, bis die Seite gewechselt hat.
  const [done, setDone] = useState(false)

  const report = (message: string) => {
    if (onError) onError(message)
    else setError(message || null)
  }

  function login() {
    report("")
    if (!browserSupportsWebAuthn()) {
      report("Dieser Browser unterstützt keine Passkeys. Bitte melden Sie sich mit E-Mail und Passwort an.")
      return
    }
    startTransition(async () => {
      // Kein try/catch um die beiden hereingegebenen Aufrufe: eine Server Action, die
      // weiterleitet, meldet das als Ausnahme, und die muss bei Next ankommen. Eine Seite,
      // die selbst abruft, fängt ihre Netzfehler in `requestOptions` und `verify`.
      const prepared = await requestOptions()
      if (prepared.error || !prepared.options) {
        report(prepared.error ?? "Die Anmeldung mit Passkey ist gerade nicht möglich.")
        return
      }

      let response: AuthenticationResponse
      try {
        response = await startAuthentication({
          // Der Server prüft, dass das Gerät die Person bestätigt hat. Hier wird es dem
          // Gerät auch gesagt, sonst fragt mancher Sicherheitsschlüssel gar nicht erst.
          optionsJSON: { ...(prepared.options as AuthenticationOptions), userVerification: "required" },
        })
      } catch (err) {
        report(describeBrowserError((err as { name?: string } | null)?.name))
        return
      }

      // Eine Server Action, die bei Erfolg weiterleitet, kommt hier nicht zurück.
      const result = await verify(response)
      if (result?.error) {
        report(result.error)
        return
      }
      setDone(true)
      onSuccess?.()
    })
  }

  const busy = pending || done

  return (
    <div className="auth-passkey">
      <div className="auth-divider" role="separator">
        <span>oder</span>
      </div>
      <button type="button" className="btn-secondary auth-passkey__btn" onClick={login} disabled={busy} aria-busy={busy}>
        {busy ? <span className="btn-spinner" aria-hidden="true" /> : <KeyRound size={15} strokeWidth={1.5} aria-hidden="true" />}
        Mit Passkey anmelden
      </button>
      {error && (
        <div className="auth-error" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
