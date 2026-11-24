'use client';

import { useEffect, type ReactNode } from 'react';
import { ToolShell, useTool } from '@/ui/tool/ToolShell';
import Sidebar from './Sidebar';
import GlobalSearch, { openGlobalSearch } from './shell/GlobalSearch';
import ActivityIndicator from './ActivityIndicator';
import { useT } from '@/lib/i18n/react';
import type { SessionData } from '@/lib/types';

/** Sitzung und `apiFetch` (mit CSRF-Token). Für jeden Aufruf an /api. */
export function useApp() {
  return useTool<SessionData>();
}

/**
 * Die Sprache der Sitzung übernehmen. Der Server rendert nach dem Cookie, und
 * das fehlt in einem Browser, in dem sich jemand noch nie angemeldet hat, bevor
 * die Anmeldung es setzt, oder nach dem Löschen der Cookies. Gewählt wird unter „Konto".
 */
function SessionLocale() {
  const { session } = useApp();
  const { locale, setLocale } = useT();
  useEffect(() => {
    if (session.locale && session.locale !== locale) setLocale(session.locale);
  }, [session.locale, locale, setLocale]);
  return null;
}

/**
 * Das Gerüst ist `ToolShell` (`ui/tool/ToolShell.tsx`): Sitzung laden, ohne
 * Sitzung zur Anmeldung, Meldungen und Bestätigungen, Rahmen.
 *
 * Kein `gate`: der zweite Faktor ist in HAPM freiwillig und wird auf der
 * Kontoseite eingerichtet, nicht vor dem ersten Blick auf die Oberfläche.
 */
export default function AppShell({ children }: { children: ReactNode }) {
  return (
    <ToolShell<SessionData>
      sidebar={({ session, apiFetch }) => (
        <Sidebar
          userName={session.name}
          userEmail={session.email}
          apiFetch={apiFetch}
          onSearch={openGlobalSearch}
        />
      )}
      after={
        <>
          <SessionLocale />
          <ActivityIndicator />
          <GlobalSearch />
        </>
      }
    >
      {children}
    </ToolShell>
  );
}
