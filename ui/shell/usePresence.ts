import { useEffect, useState } from "react"

/**
 * Hält ein Element nach dem Schließen noch so lange im Baum, wie es ausblendet.
 * `mounted` entscheidet über das Rendern, `closing` setzt die Klasse für die
 * Ausblend-Animation (`shell-pop-out`, 120 ms).
 */
export function usePresence(open: boolean, ms = 120): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open)
  // Beim Öffnen sofort da, ohne den Umweg über einen Effekt.
  if (open && !mounted) setMounted(true)

  useEffect(() => {
    if (open || !mounted) return
    const timer = setTimeout(() => setMounted(false), ms)
    return () => clearTimeout(timer)
  }, [open, mounted, ms])

  return { mounted, closing: mounted && !open }
}
