'use client';

import { useCallback } from 'react';
import SharedGlobalSearch, { type GlobalSearchGroup } from '@/ui/shell/GlobalSearch';
import { useApp } from '@/components/AppShell';
import { NAV_PAGES } from '@/components/Sidebar';
import { useT } from '@/lib/i18n/react';
import {
  SEARCH_MAX_PER_GROUP,
  SEARCH_MIN_LENGTH,
  matchesSearch,
  searchWords,
  type SearchGroup,
} from '@/lib/search';

export { openGlobalSearch } from '@/ui/shell/GlobalSearch';

/**
 * Die Seiten aus der Navigation, im Browser gefiltert: sie stehen sofort da.
 * Gesucht wird in den Namen der gewählten Sprache, denn die stehen in der Leiste.
 */
function pagesFor(query: string, t: (text: string) => string): GlobalSearchGroup[] {
  const words = searchWords(query);
  const pages = NAV_PAGES.map((page) => ({
    ...page,
    title: t(page.title),
    subtitle: page.subtitle ? t(page.subtitle) : undefined,
  }))
    .filter((page) => matchesSearch([page.title, page.subtitle], words))
    .slice(0, SEARCH_MAX_PER_GROUP);
  return pages.length > 0 ? [{ label: t('Seiten'), items: pages }] : [];
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
  const { t } = useT();
  const localGroups = useCallback((query: string) => pagesFor(query, t), [t]);

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
      placeholder={t('Seiten, Domains, Dienste, Backend-Adressen')}
      minLength={SEARCH_MIN_LENGTH}
      localGroups={localGroups}
      search={search}
    />
  );
}
