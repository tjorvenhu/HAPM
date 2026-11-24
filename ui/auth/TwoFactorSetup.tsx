"use client"

import { useState, useRef, type FormEvent } from "react"
import { ShieldCheck, Copy, Check, Loader2, ArrowLeft, ArrowRight, X } from "lucide-react"

export interface TwoFactorSetupProps {
  /**
   * Beginnt die Einrichtung beim Server und liefert den QR-Code (als Daten-Adresse) und das
   * Geheimnis zum Abtippen. Wirft mit einer Meldung für den Nutzer, wenn es nicht geht.
   */
  start: () => Promise<{ qrCodeDataUrl: string; manualCode: string }>
  /**
   * Prüft den ersten Code und schaltet den zweiten Faktor scharf. Liefert der Server
   * Wiederherstellungscodes, zeigt der Baustein sie einmal an. Wirft mit einer Meldung
   * für den Nutzer, wenn der Code nicht stimmt.
   */
  verify: (code: string) => Promise<{ recoveryCodes?: string[] } | void>
  onComplete: () => void
  onCancel?: () => void
  /** Pflicht oder freiwillig: ändert nur den ersten Satz. In HAPM ist der zweite Faktor freiwillig. */
  required?: boolean
  /** Zusätzliche Klasse an der Fläche. Außerhalb des Rahmens `shell-page`, damit dessen Werte gelten. */
  className?: string
}

type Step = "intro" | "loading" | "scan" | "verify" | "recovery" | "done"

/**
 * Die Einrichtung des zweiten Faktors (TOTP) in vier Schritten: Erklärung, QR-Code,
 * Code prüfen, auf Wunsch Wiederherstellungscodes. Liegt als Fläche über der Seite.
 *
 * Die Anbindung gibt die Seite herein (`start`, `verify`): mal ein Abruf mit
 * CSRF-Kopfzeile, mal ohne. Form und Ablauf stehen hier, die Regeln dazu
 * (`.two-factor-*`) in `css/tool-vocabulary.css`.
 */
export default function TwoFactorSetup({ start, verify, onComplete, onCancel, required = false, className }: TwoFactorSetupProps) {
  const [step, setStep] = useState<Step>("intro")
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState("")
  const [manualCode, setManualCode] = useState("")
  const [code, setCode] = useState("")
  const [error, setError] = useState("")
  const [copied, setCopied] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])
  const [recoveryCopied, setRecoveryCopied] = useState(false)
  const codeInputRef = useRef<HTMLInputElement>(null)

  async function startSetup() {
    setStep("loading")
    setError("")
    try {
      const data = await start()
      setQrCodeDataUrl(data.qrCodeDataUrl)
      setManualCode(data.manualCode)
      setStep("scan")
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Fehler bei der Einrichtung")
      setStep("intro")
    }
  }

  function copyManualCode() {
    navigator.clipboard.writeText(manualCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function verifyCode(e: FormEvent) {
    e.preventDefault()
    setError("")
    setVerifying(true)
    try {
      const data = await verify(code)
      if (data && Array.isArray(data.recoveryCodes) && data.recoveryCodes.length > 0) {
        setRecoveryCodes(data.recoveryCodes)
        setStep("recovery")
      } else {
        setStep("done")
        setTimeout(onComplete, 1500)
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Verifizierung fehlgeschlagen")
      setCode("")
    } finally {
      setVerifying(false)
    }
  }

  return (
    <div className={className ? `two-factor-overlay ${className}` : "two-factor-overlay"}>
      <div className="two-factor-dialog">
        <div className="two-factor-header">
          <ShieldCheck size={32} />
          <h2>Zwei-Faktor-Authentifizierung einrichten</h2>
        </div>

        {error && <div className="two-factor-error" style={{ margin: "0 0 16px" }}>{error}</div>}

        {step === "intro" && (
          <div className="two-factor-body">
            <p>
              {required
                ? "Zur Sicherheit Ihres Kontos ist die Zwei-Faktor-Authentifizierung (2FA) erforderlich."
                : "Mit der Zwei-Faktor-Authentifizierung (2FA) braucht die Anmeldung zusätzlich einen Code von Ihrem Handy."}{" "}
              Sie benötigen eine Authenticator-App wie:
            </p>
            <ul style={{ margin: "12px 0", paddingLeft: 20, color: "var(--text-secondary)" }}>
              <li>Google Authenticator</li>
              <li>Microsoft Authenticator</li>
              <li>Authy</li>
              <li>1Password</li>
            </ul>
            {onCancel && (
              <button className="two-factor-btn two-factor-btn--ghost" style={{ alignSelf: "center", marginTop: 8 }} onClick={onCancel}>
                <X size={15} /> Abbrechen
              </button>
            )}
            <button className="two-factor-btn two-factor-btn--primary" style={{ alignSelf: "center", marginTop: 8 }} onClick={startSetup}>
              Einrichtung starten
            </button>
          </div>
        )}

        {step === "loading" && (
          <div className="two-factor-body" style={{ textAlign: "center", alignItems: "center", padding: "32px 0" }}>
            <Loader2 size={32} className="spin" />
            <p style={{ marginTop: 12, color: "var(--text-secondary)" }}>QR-Code wird generiert...</p>
          </div>
        )}

        {step === "scan" && (
          <div className="two-factor-body">
            <p style={{ marginBottom: 16, color: "var(--text-secondary)", fontSize: "0.875rem" }}>
              Scannen Sie den QR-Code mit Ihrer Authenticator-App oder geben Sie den Code manuell ein.
            </p>

            <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
              {/* Ein Daten-Bild vom eigenen Server: next/image brächte hier nichts. */}
              <img
                src={qrCodeDataUrl}
                alt="2FA QR-Code"
                width={200}
                height={200}
                style={{ borderRadius: 8, border: "1px solid var(--border)" }}
              />
            </div>

            <div style={{
              background: "var(--bg-warm)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "12px 16px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              marginBottom: 20,
            }}>
              <code style={{ fontSize: "0.75rem", wordBreak: "break-all", flex: 1 }}>{manualCode}</code>
              <button
                type="button"
                className="two-factor-btn two-factor-btn--ghost"
                onClick={copyManualCode}
                data-tooltip="Code kopieren"
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>

            <button
              className="two-factor-btn two-factor-btn--primary"
              style={{ alignSelf: "center", marginTop: 4 }}
              onClick={() => { setStep("verify"); setTimeout(() => codeInputRef.current?.focus(), 100) }}
            >
              Weiter <ArrowRight size={15} />
            </button>
          </div>
        )}

        {step === "verify" && (
          <form className="two-factor-body" onSubmit={verifyCode}>
            <p style={{ marginBottom: 16, color: "var(--text-secondary)", fontSize: "0.875rem" }}>
              Geben Sie den 6-stelligen Code aus Ihrer Authenticator-App ein, um die Einrichtung abzuschließen.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 20 }}>
              <input
                ref={codeInputRef}
                className="two-factor-code-input"
                type="text"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                required
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="000000"
                autoComplete="one-time-code"
              />
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button type="button" className="two-factor-btn two-factor-btn--secondary" style={{ flex: 1 }} onClick={() => setStep("scan")}>
                <ArrowLeft size={15} /> Zurück
              </button>
              <button type="submit" className="two-factor-btn two-factor-btn--primary" style={{ flex: 1 }} disabled={verifying || code.length !== 6}>
                {verifying ? <span className="btn-spinner" aria-hidden="true" /> : <ShieldCheck size={15} />}
                {verifying ? "Prüfen…" : "Aktivieren"}
              </button>
            </div>
          </form>
        )}

        {step === "recovery" && (
          <div className="two-factor-body">
            <p style={{ marginBottom: 12, fontWeight: 600, color: "var(--text)" }}>
              Wiederherstellungscodes speichern
            </p>
            <p style={{ marginBottom: 16, color: "var(--text-secondary)", fontSize: "0.875rem" }}>
              Mit diesen Codes können Sie sich anmelden, falls Sie den Zugriff auf Ihre
              Authenticator-App verlieren. Jeder Code ist einmal verwendbar und wird
              <strong> nur jetzt</strong> angezeigt.
            </p>

            <div style={{
              background: "var(--bg-warm)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "12px 16px",
              marginBottom: 16,
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "6px 16px",
            }}>
              {recoveryCodes.map((rc) => (
                <code key={rc} style={{ fontSize: "0.8125rem" }}>{rc}</code>
              ))}
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <button
                type="button"
                className="two-factor-btn two-factor-btn--secondary"
                style={{ flex: 1 }}
                onClick={() => {
                  navigator.clipboard.writeText(recoveryCodes.join("\n"))
                  setRecoveryCopied(true)
                  setTimeout(() => setRecoveryCopied(false), 2000)
                }}
              >
                {recoveryCopied ? <Check size={14} /> : <Copy size={14} />}
                {recoveryCopied ? "Kopiert" : "Kopieren"}
              </button>
              <button
                type="button"
                className="two-factor-btn two-factor-btn--primary"
                style={{ flex: 1 }}
                onClick={() => { setStep("done"); setTimeout(onComplete, 1500) }}
              >
                <Check size={15} /> Codes gespeichert
              </button>
            </div>
          </div>
        )}

        {step === "done" && (
          <div className="two-factor-body" style={{ alignItems: "center", padding: "32px 0", textAlign: "center" }}>
            <div className="two-factor-success-icon">
              <Check size={32} strokeWidth={3} />
            </div>
            <p style={{ marginTop: 20, fontWeight: 600, fontSize: "1.0625rem", color: "var(--text)" }}>
              2FA erfolgreich aktiviert!
            </p>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem", marginTop: 6 }}>
              Sie werden weitergeleitet...
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
