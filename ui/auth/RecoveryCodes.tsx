"use client"

import { useState } from "react"
import { useT } from "@/lib/i18n/react"

/**
 * Wiederherstellungscodes zum einmaligen Ansehen: die Liste und was man mit ihr
 * tut (kopieren, als Textdatei laden). Die Knöpfe setzt jede Stelle selbst, in
 * der Einrichtung als `two-factor-btn`, auf der Kontoseite als `btn`.
 */
export function RecoveryCodeGrid({ codes }: { codes: string[] }) {
  return (
    <div
      style={{
        background: "var(--bg-warm)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "12px 16px",
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: "6px 16px",
      }}
    >
      {codes.map((rc) => (
        <code key={rc} style={{ fontSize: "0.8125rem" }}>{rc}</code>
      ))}
    </div>
  )
}

/**
 * Kopieren scheitert ohne HTTPS: die Zwischenablage gibt es nur in einem
 * sicheren Kontext, und HAPM läuft in der Einrichtung unter IP und Port. Dann
 * meldet `copy` es über `onCopyFailed`, und das Herunterladen geht trotzdem.
 */
export function useRecoveryCodeActions(codes: string[], onCopyFailed: (message: string) => void) {
  const { t } = useT()
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(codes.join("\n"))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      onCopyFailed(t("Kopieren nicht möglich. Bitte laden Sie die Codes herunter oder markieren Sie sie von Hand."))
    }
  }

  function download() {
    const text = [t("Wiederherstellungscodes für HAPM ({host})", { host: window.location.host }), "", ...codes, ""].join("\n")
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }))
    const link = document.createElement("a")
    link.href = url
    link.download = "hapm-recovery-codes.txt"
    link.click()
    URL.revokeObjectURL(url)
  }

  return { copied, copy, download }
}
