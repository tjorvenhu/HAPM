import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Die zuklappbaren Gruppen der Seitenleiste (`ui/shell/useNavGroups.ts`).
 *
 * Geprüft wird die Regel, nicht das Bild: was gemerkt wird, wann ein
 * Seitenwechsel eine Gruppe aufklappt und wann sie trotz der aktiven Seite zu
 * bleibt.
 */

interface FakeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function fakeStorage(): FakeStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

function brokenStorage(): FakeStorage {
  const fail = () => {
    throw new Error('SecurityError');
  };
  return { getItem: fail, setItem: fail, removeItem: fail };
}

function stubWindow(local: FakeStorage, session: FakeStorage) {
  vi.stubGlobal('window', {
    localStorage: local,
    sessionStorage: session,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
}

async function load() {
  return import('@/ui/shell/useNavGroups');
}

const SYSTEM = 'gruppesystem';
const PROXY = 'gruppereverse-proxy';

describe('Gruppen der Seitenleiste', () => {
  let local: FakeStorage;
  let session: FakeStorage;

  beforeEach(() => {
    vi.resetModules();
    local = fakeStorage();
    session = fakeStorage();
    stubWindow(local, session);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ohne gespeicherten Stand ist alles offen', async () => {
    const nav = await load();
    expect(nav.readNavGroups()).toEqual({ collapsed: [], held: null });
    expect(nav.navGroupClosed(nav.readNavGroups(), SYSTEM, null, null)).toBe(false);
  });

  it('merkt eine zugeklappte Gruppe für den Browser, unter einem Schlüssel', async () => {
    const nav = await load();
    nav.setNavGroupClosed(SYSTEM, true, null);
    nav.setNavGroupClosed(PROXY, true, null);
    expect(JSON.parse(local.getItem('hapm-sidebar-groups-v1') ?? '')).toEqual([SYSTEM, PROXY]);
    expect(nav.navGroupClosed(nav.readNavGroups(), SYSTEM, 'gruppeuebersicht', '/dashboard')).toBe(true);

    nav.setNavGroupClosed(SYSTEM, false, null);
    nav.setNavGroupClosed(PROXY, false, null);
    expect(local.getItem('hapm-sidebar-groups-v1')).toBeNull();
  });

  it('liefert dasselbe Objekt, solange sich nichts ändert', async () => {
    const nav = await load();
    nav.setNavGroupClosed(SYSTEM, true, null);
    expect(nav.readNavGroups()).toBe(nav.readNavGroups());
  });

  it('ein Seitenwechsel in eine zugeklappte Gruppe klappt sie auf, und sie bleibt offen', async () => {
    const nav = await load();
    nav.setNavGroupClosed(SYSTEM, true, null);
    nav.setNavGroupClosed(PROXY, true, null);

    // Schon vor dem Merken zeigt die Leiste die Gruppe der aktiven Seite offen.
    expect(nav.navGroupClosed(nav.readNavGroups(), SYSTEM, SYSTEM, '/updates')).toBe(false);

    nav.openNavGroupOf(SYSTEM, '/updates');
    expect(nav.readNavGroups().collapsed).toEqual([PROXY]);

    nav.openNavGroupOf('gruppeuebersicht', '/dashboard');
    expect(nav.navGroupClosed(nav.readNavGroups(), SYSTEM, 'gruppeuebersicht', '/dashboard')).toBe(false);
    expect(nav.navGroupClosed(nav.readNavGroups(), PROXY, 'gruppeuebersicht', '/dashboard')).toBe(true);
  });

  it('von Hand zugeklappt bleibt die Gruppe der aktiven Seite zu, auch nach dem Neuladen', async () => {
    const nav = await load();
    nav.setNavGroupClosed(SYSTEM, true, '/updates');
    expect(nav.navGroupClosed(nav.readNavGroups(), SYSTEM, SYSTEM, '/updates')).toBe(true);

    // Neuladen: derselbe Tab, dieselbe Seite.
    vi.resetModules();
    const reloaded = await load();
    reloaded.openNavGroupOf(SYSTEM, '/updates');
    expect(reloaded.navGroupClosed(reloaded.readNavGroups(), SYSTEM, SYSTEM, '/updates')).toBe(true);
  });

  it('der nächste Seitenwechsel hebt das auf: eine andere Seite der Gruppe klappt sie auf', async () => {
    const nav = await load();
    nav.setNavGroupClosed(SYSTEM, true, '/updates');
    nav.openNavGroupOf(SYSTEM, '/backup');
    expect(nav.readNavGroups()).toEqual({ collapsed: [], held: null });
  });

  it('nach einem Umweg über eine andere Gruppe klappt auch dieselbe Seite wieder auf', async () => {
    const nav = await load();
    nav.setNavGroupClosed(SYSTEM, true, '/updates');

    nav.openNavGroupOf('gruppeuebersicht', '/dashboard');
    expect(nav.readNavGroups()).toEqual({ collapsed: [SYSTEM], held: null });

    nav.openNavGroupOf(SYSTEM, '/updates');
    expect(nav.readNavGroups().collapsed).toEqual([]);
  });

  it('ein neuer Tab kennt das Zuklappen von Hand nicht: der direkte Aufruf klappt auf', async () => {
    const nav = await load();
    nav.setNavGroupClosed(SYSTEM, true, '/updates');

    vi.resetModules();
    stubWindow(local, fakeStorage());
    const other = await load();
    expect(other.navGroupClosed(other.readNavGroups(), SYSTEM, SYSTEM, '/updates')).toBe(false);
    other.openNavGroupOf(SYSTEM, '/updates');
    expect(other.readNavGroups().collapsed).toEqual([]);
  });

  it('wieder aufgeklappt von Hand ist die Gruppe offen und nichts mehr gemerkt', async () => {
    const nav = await load();
    nav.setNavGroupClosed(SYSTEM, true, '/updates');
    nav.setNavGroupClosed(SYSTEM, false, '/updates');
    expect(nav.readNavGroups()).toEqual({ collapsed: [], held: null });
    expect(session.getItem('hapm-sidebar-held-v1')).toBeNull();
  });

  it('übersteht einen kaputten gespeicherten Stand', async () => {
    local.setItem('hapm-sidebar-groups-v1', '{"nicht":"eine Liste"');
    const nav = await load();
    expect(nav.readNavGroups().collapsed).toEqual([]);

    local.setItem('hapm-sidebar-groups-v1', JSON.stringify([SYSTEM, 7, null]));
    expect(nav.readNavGroups().collapsed).toEqual([SYSTEM]);
  });

  it('ohne Speicher gilt der Stand bis zum Neuladen', async () => {
    stubWindow(brokenStorage(), brokenStorage());
    const nav = await load();
    nav.setNavGroupClosed(SYSTEM, true, '/updates');
    expect(nav.readNavGroups()).toEqual({ collapsed: [SYSTEM], held: '/updates' });

    vi.resetModules();
    const reloaded = await load();
    expect(reloaded.readNavGroups()).toEqual({ collapsed: [], held: null });
  });
});
