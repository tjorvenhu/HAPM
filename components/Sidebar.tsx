'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  LayoutDashboard, Network, BarChart3, ShieldCheck, ScrollText, Globe, SlidersHorizontal,
  Plug, PackageCheck, DatabaseBackup, Bell, Settings, Users, UserCog, FileWarning, Palette, type LucideIcon,
} from 'lucide-react';
import { useState, useEffect, useMemo } from 'react';
import { ShellSidebar, type ShellNavArea, type ShellNavGroup } from '@/ui/shell/ShellSidebar';
import { ShellProfileMenu } from '@/ui/shell/ShellProfileMenu';
import { Logo } from '@/ui/primitives/Logo';
import { msgid } from '@/lib/i18n/translate';
import { useT } from '@/lib/i18n/react';

/** Die Zähler aus `/api/nav-counts`. */
type NavCount = 'updates';

interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  badge?: NavCount;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

/**
 * Die Gliederung der Leiste. Aus ihr kommen auch der Titel im Browser
 * (`activeArea`) und die Seiten der globalen Suche (`NAV_PAGES`): ein neuer
 * Eintrag bringt beides mit.
 *
 * Die Namen bleiben deutsch (`msgid`) und werden erst beim Zeigen übersetzt,
 * damit Titel, Suche und Leiste denselben Schlüssel benutzen.
 */
const NAV_SECTIONS: NavSection[] = [
  {
    title: msgid('Übersicht'),
    items: [{ label: msgid('Übersicht'), href: '/dashboard', icon: LayoutDashboard }],
  },
  {
    // Was man einrichtet. Die Einstellungen am Ende, wie in jeder Gruppe.
    title: msgid('Reverse-Proxy'),
    items: [
      { label: msgid('Ziele'), href: '/reverse-proxy', icon: Network },
      { label: msgid('Zertifikate'), href: '/reverse-proxy/zertifikate', icon: ShieldCheck },
      { label: msgid('DNS'), href: '/dns', icon: Globe },
      { label: msgid('Fehlerseiten'), href: '/reverse-proxy/fehlerseiten', icon: FileWarning },
      { label: msgid('API und MCP'), href: '/reverse-proxy/api', icon: Plug },
      { label: msgid('Einstellungen'), href: '/reverse-proxy/einstellungen', icon: SlidersHorizontal },
    ],
  },
  {
    // Was man beobachtet: hier wird nichts eingestellt.
    title: msgid('Auswertung'),
    items: [
      { label: msgid('Statistik'), href: '/reverse-proxy/statistiken', icon: BarChart3 },
      { label: msgid('Logs'), href: '/reverse-proxy/logs', icon: ScrollText },
    ],
  },
  {
    title: msgid('System'),
    items: [
      { label: msgid('Updates'), href: '/updates', icon: PackageCheck, badge: 'updates' },
      { label: msgid('Sicherung'), href: '/backup', icon: DatabaseBackup },
      { label: msgid('Benachrichtigungen'), href: '/notifications', icon: Bell },
      { label: msgid('Benutzer'), href: '/users', icon: Users },
      { label: msgid('Allgemein'), href: '/system', icon: Settings },
      { label: msgid('Darstellung'), href: '/system/darstellung', icon: Palette },
    ],
  },
];

/**
 * Das eigene Konto steht nicht in der Seitenleiste, sondern im Menü unter dem
 * Benutzer: es gehört zur Person, nicht zum System. Suche und Browsertitel
 * kennen es trotzdem.
 */
const ACCOUNT_PAGE: NavItem = { label: msgid('Konto'), href: '/konto', icon: UserCog };

/**
 * Jede Seite der Navigation als Suchtreffer, mit ihrem Bereich als Nebenzeile.
 * Speist die Gruppe „Seiten" der globalen Suche.
 */
export const NAV_PAGES: { title: string; subtitle?: string; href: string }[] = [
  ...NAV_SECTIONS.flatMap((section) =>
    section.items.map((item) => ({
      title: item.label,
      // „Übersicht" unter „Übersicht" sagt nichts.
      subtitle: section.title === item.label ? undefined : section.title,
      href: item.href,
    }))
  ),
  { title: ACCOUNT_PAGE.label, href: ACCOUNT_PAGE.href },
];

/**
 * Die Seite, die im Browsertitel steht.
 *
 * Der längste passende Eintrag gewinnt, über alle Bereiche hinweg:
 * `/reverse-proxy/api` gehört zu „API und MCP" und nicht zu „Ziele", obwohl
 * `/reverse-proxy` ein Präfix davon ist. Die Seite einer Gruppe
 * (`/reverse-proxy/<gruppe>`) hat keinen eigenen Eintrag und fällt auf „Ziele".
 */
export function activeArea(pathname: string): string | null {
  let best: NavItem | null = null;
  for (const item of [...NAV_SECTIONS.flatMap((section) => section.items), ACCOUNT_PAGE]) {
    const matches = pathname === item.href || pathname.startsWith(`${item.href}/`);
    if (matches && (!best || item.href.length > best.href.length)) best = item;
  }
  return best?.label ?? null;
}

/** Schlüssel, der auch als Teil einer HTML-Kennung taugt. */
function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/** Aus den Bereichen wird die Gliederung für `ShellSidebar`: je Bereich eine Gruppe mit Überschrift. */
function buildNavigation(t: (text: string) => string): { groups: ShellNavGroup[]; areas: ShellNavArea[] } {
  const groups: ShellNavGroup[] = [];
  const areas: ShellNavArea[] = [];

  for (const section of NAV_SECTIONS) {
    const group = `gruppe${slug(section.title)}`;
    groups.push({
      key: group,
      // Über der einzelnen „Übersicht" ordnet eine Überschrift nichts.
      heading: groups.length === 0 ? undefined : t(section.title),
      label: t(section.title),
    });
    for (const item of section.items) {
      areas.push({
        key: `seite${slug(item.href)}`,
        href: item.href,
        label: t(item.label),
        icon: item.icon,
        group,
        ...(item.badge ? { counts: [item.badge] } : {}),
      });
    }
  }
  return { groups, areas };
}

interface SidebarProps {
  userName: string;
  userEmail: string;
  /** `apiFetch` aus der Hülle: setzt den CSRF-Token, den das Abmelden braucht. */
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Öffnet die globale Suche. Zeigt den Knopf „Suchen". */
  onSearch?: () => void;
}

/**
 * Die Seitenleiste. Aufbau, Verhalten und Aussehen stehen in
 * `ui/shell/ShellSidebar.tsx`. Hier steht nur, was HAPM hereingibt: Gliederung,
 * Zähler, Logo und Abmelden.
 */
export default function Sidebar({ userName, userEmail, apiFetch, onSearch }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useT();
  const navigation = useMemo(() => buildNavigation(t), [t]);
  const [counts, setCounts] = useState<Partial<Record<NavCount, number>>>({});

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/nav-counts')
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((body) => {
        if (!cancelled && body.success && body.data) setCounts(body.data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [apiFetch, pathname]);

  const handleLogout = async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    router.push('/login');
  };

  return (
    <ShellSidebar
      root="/dashboard"
      areas={navigation.areas}
      groups={navigation.groups}
      logo={<Logo width={132} />}
      counts={Object.entries(counts).map(([key, count]) => ({ key, count: count ?? 0 }))}
      onSearch={onSearch}
      footer={
        <ShellProfileMenu name={userName} email={userEmail} onLogout={handleLogout}>
          {(close) => (
            <Link
              href={ACCOUNT_PAGE.href}
              role="menuitem"
              className="shell-menu__item"
              aria-current={pathname === ACCOUNT_PAGE.href ? 'page' : undefined}
              onClick={close}
            >
              <UserCog size={16} strokeWidth={1.5} aria-hidden="true" />
              {t(ACCOUNT_PAGE.label)}
            </Link>
          )}
        </ShellProfileMenu>
      }
    />
  );
}
