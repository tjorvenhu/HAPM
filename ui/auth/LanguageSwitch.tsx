"use client"

import { useRouter } from "next/navigation"
import { Languages } from "lucide-react"
import { LOCALES, LOCALE_NAMES } from "@/lib/i18n/locale"
import { useT } from "@/lib/i18n/react"

/**
 * Die Sprache auf den Seiten vor der Anmeldung: Anmeldung, „Passwort
 * vergessen", Einrichtung, Fehlerseiten. Setzt nur das Cookie, ein Konto gibt
 * es hier noch nicht. Nach der Anmeldung gilt die Wahl unter „Konto".
 *
 * `router.refresh()`, weil Titel und `<html lang>` vom Server kommen.
 */
export function LanguageSwitch() {
  const { locale, setLocale, t } = useT()
  const router = useRouter()

  return (
    <div className="auth-language" role="group" aria-label={t("Sprache")}>
      <Languages size={14} strokeWidth={1.5} aria-hidden="true" />
      {LOCALES.map((option) => (
        <button
          key={option}
          type="button"
          className="auth-language__option"
          aria-pressed={option === locale}
          lang={option}
          onClick={() => {
            if (option === locale) return
            setLocale(option)
            router.refresh()
          }}
        >
          {LOCALE_NAMES[option]}
        </button>
      ))}
    </div>
  )
}

export default LanguageSwitch
