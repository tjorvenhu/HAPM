"use client"

import { useFormStatus } from "react-dom"
import type { ReactNode } from "react"

interface Props {
  children: ReactNode
  /** Text während der laufenden Aktion; ohne Angabe bleiben die children stehen. */
  pendingText?: string
  className?: string
  disabled?: boolean
}

/**
 * Submit-Button mit Lade-Spinner. Muss innerhalb eines <form> stehen —
 * der Pending-Zustand kommt aus useFormStatus, es ist kein Prop-Threading nötig.
 */
export function SubmitButton({ children, pendingText, className = "btn-primary", disabled }: Props) {
  const { pending } = useFormStatus()
  return (
    <button type="submit" className={className} disabled={pending || disabled} aria-busy={pending}>
      {pending && <span className="btn-spinner" aria-hidden="true" />}
      {pending && pendingText ? pendingText : children}
    </button>
  )
}
