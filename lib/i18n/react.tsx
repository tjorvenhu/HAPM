'use client';

/**
 * Die Sprache im Browser: ein Provider um alle Seiten (`app/layout.tsx`) und
 * `useT()` darin.
 *
 * Die erste Sprache kommt vom Server (Cookie oder Browser), damit das
 * ausgelieferte HTML schon stimmt. `AppShell` stellt sie auf die Wahl am Konto
 * um, sobald die Sitzung da ist, und der Umschalter vor der Anmeldung setzt
 * nur das Cookie.
 */

import { createContext, Fragment, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_LOCALE, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, type Locale } from './locale';
import { createTranslator, translate, type Translatable, type Translator } from './translate';

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

const I18nContext = createContext<I18nContextValue | null>(null);

/** Das Cookie im Browser setzen. Dieselben Angaben wie `setLocaleCookie` auf dem Server. */
export function writeLocaleCookie(locale: Locale): void {
  document.cookie = `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax`;
}

export function I18nProvider({ initialLocale, children }: { initialLocale: Locale; children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    document.documentElement.lang = next;
    writeLocaleCookie(next);
  }, []);

  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export interface ClientTranslator extends Translator {
  /** Die Sprache wechseln: Zustand, `<html lang>` und Cookie. Speichert nichts am Konto. */
  setLocale: (locale: Locale) => void;
  /**
   * Ein Satz mit Elementen darin: `rich('Dort setzt {command} ein neues
   * Passwort.', { command: <code>…</code> })`. Der Satz bleibt ein Schlüssel,
   * die Elemente stehen dort, wo im Text ihr Platzhalter steht.
   */
  rich: (text: Translatable, nodes: Record<string, ReactNode>) => ReactNode;
}

/**
 * `t()`, `plural()` und `rich()` in der Sprache der Seite. Außerhalb des
 * Providers Deutsch, damit ein Baustein auch allein funktioniert.
 */
export function useT(): ClientTranslator {
  const context = useContext(I18nContext);
  const locale = context?.locale ?? DEFAULT_LOCALE;
  const setLocale = context?.setLocale;

  return useMemo(() => {
    const translator = createTranslator(locale);
    return {
      ...translator,
      setLocale: setLocale ?? (() => {}),
      rich: (text, nodes) => richText(translate(locale, text), nodes),
    };
  }, [locale, setLocale]);
}

/** Zerlegt den übersetzten Text an seinen Platzhaltern und setzt die Elemente ein. */
export function richText(text: string, nodes: Record<string, ReactNode>): ReactNode {
  const parts = text.split(/\{(\w+)\}/g);
  return parts.map((part, index) => {
    // Ungerade Stellen sind die Namen der Platzhalter.
    if (index % 2 === 1) {
      return Object.hasOwn(nodes, part) ? <Fragment key={index}>{nodes[part]}</Fragment> : `{${part}}`;
    }
    return part;
  });
}
