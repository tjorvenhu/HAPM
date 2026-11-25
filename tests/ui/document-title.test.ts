import { describe, it, expect } from 'vitest';
import { documentTitle } from '@/components/DocumentTitle';
import { NAV_PAGES } from '@/components/Sidebar';

/**
 * Der Titel im Browsertab: "<Seite> · HAPM".
 *
 * Er kommt aus derselben Tabelle wie die Seitenleiste: ein neuer Menüpunkt
 * bringt seinen Titel mit.
 */

describe('documentTitle', () => {
  it('nennt die Seite aus der Navigation', () => {
    expect(documentTitle('/dashboard')).toBe('Übersicht · HAPM');
    expect(documentTitle('/reverse-proxy')).toBe('Ziele · HAPM');
    expect(documentTitle('/reverse-proxy/zertifikate')).toBe('Zertifikate · HAPM');
    expect(documentTitle('/dns')).toBe('DNS · HAPM');
    expect(documentTitle('/reverse-proxy/api')).toBe('API und MCP · HAPM');
    expect(documentTitle('/updates')).toBe('Updates · HAPM');
    expect(documentTitle('/backup')).toBe('Sicherung · HAPM');
    expect(documentTitle('/notifications')).toBe('Benachrichtigungen · HAPM');
    expect(documentTitle('/system')).toBe('Allgemein · HAPM');
    expect(documentTitle('/users')).toBe('Benutzer · HAPM');
    expect(documentTitle('/konto')).toBe('Konto · HAPM');
  });

  it('zählt Unterseiten zu ihrem Eintrag', () => {
    expect(documentTitle('/dns/zone_123')).toBe('DNS · HAPM');
    // Die Seite einer Gruppe hat keinen eigenen Eintrag.
    expect(documentTitle('/reverse-proxy/kunden-websites')).toBe('Ziele · HAPM');
  });

  it('der längere Treffer gewinnt, auch über Bereichsgrenzen hinweg', () => {
    // /reverse-proxy (Ziele) ist ein Präfix von /reverse-proxy/api, und die API
    // steht in einem anderen Bereich der Leiste.
    expect(documentTitle('/reverse-proxy/api')).toBe('API und MCP · HAPM');
    expect(documentTitle('/reverse-proxy/logs')).toBe('Logs · HAPM');
    expect(documentTitle('/reverse-proxy/statistiken')).toBe('Statistik · HAPM');
    expect(documentTitle('/reverse-proxy/einstellungen')).toBe('Einstellungen · HAPM');
  });

  it('nimmt den eigenen Namen aus „Darstellung“, die Seite selbst gewinnt gegen „Allgemein“', () => {
    expect(documentTitle('/system/darstellung')).toBe('Darstellung · HAPM');
    expect(documentTitle('/updates', (text) => text, 'Nordwind')).toBe('Updates · Nordwind');
    expect(documentTitle('/nirgends', (text) => text, 'Nordwind')).toBe('Nordwind');
  });

  it('bleibt ohne passenden Eintrag beim nackten Produktnamen', () => {
    expect(documentTitle('/gibtsnicht')).toBe('HAPM');
  });
});

describe('NAV_PAGES', () => {
  it('führt jede Adresse genau einmal', () => {
    const hrefs = NAV_PAGES.map((page) => page.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('nennt den Bereich als Nebenzeile, außer er hieße wie die Seite', () => {
    expect(NAV_PAGES.find((page) => page.href === '/reverse-proxy/logs')?.subtitle).toBe('Auswertung');
    expect(NAV_PAGES.find((page) => page.href === '/reverse-proxy/zertifikate')?.subtitle).toBe('Reverse-Proxy');
    expect(NAV_PAGES.find((page) => page.href === '/dashboard')?.subtitle).toBeUndefined();
  });
});
