'use client';

import { useCallback } from 'react';
import SharedGlobalSearch, { type GlobalSearchGroup } from '@/ui/shell/GlobalSearch';
import { useApp } from '@/components/AppShell';
import { NAV_PAGES } from '@/components/Sidebar';
import {
  SEARCH_MAX_PER_GROUP,
  SEARCH_MIN_LENGTH,
  matchesSearch,
  searchWords,
  type SearchGroup,
} from '@/lib/search';

export { openGlobalSearch } from '@/ui/shell/GlobalSearch';

/** Die Seiten aus der Navigation, im Browser gefiltert: sie stehen sofort da. */
function pagesFor(query: string): GlobalSearchGroup[] {
  const words = searchWords(query);
  const pages = NAV_PAGES.filter((page) => matchesSearch([page.title, page.subtitle], words)).slice(
    0,
    SEARCH_MAX_PER_GROUP
  );
  return pages.length > 0 ? [{ label: 'Seiten', items: pages }] : [];
}

/**
 * Die globale Suche: Strg K (oder Cmd K) öffnet eine Palette über die Seiten
 * des Werkzeugs und über die Ziele des Reverse-Proxys.
 *
 * Form und Bedienung stehen in `ui/shell/GlobalSearch.tsx`. Hier steht nur, wonach gesucht
 * wird: die Seiten aus der Navigation und, was `/api/search` findet.
 */
export default function GlobalSearch() {
  const { apiFetch } = useApp();

  const search = useCallback(
    async (query: string): Promise<GlobalSearchGroup[]> => {
      const res = await apiFetch(`/api/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      return res.ok && data.success ? (data.data.groups as SearchGroup[]) : [];
    },
    [apiFetch]
  );

  return (
    <SharedGlobalSearch
      placeholder="Seiten, Domains, Dienste, Backend-Adressen"
      minLength={SEARCH_MIN_LENGTH}
      localGroups={pagesFor}
      search={search}
    />
  );
}
