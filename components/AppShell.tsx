'use client';

import type { ReactNode } from 'react';
import { ToolShell, useTool } from '@/ui/tool/ToolShell';
import Sidebar from './Sidebar';
import GlobalSearch, { openGlobalSearch } from './shell/GlobalSearch';
import ActivityIndicator from './ActivityIndicator';
import type { SessionData } from '@/lib/types';

/** Sitzung und `apiFetch` (mit CSRF-Token). Für jeden Aufruf an /api. */
export function useApp() {
  return useTool<SessionData>();
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
          <ActivityIndicator />
          <GlobalSearch />
        </>
      }
    >
      {children}
    </ToolShell>
  );
}
