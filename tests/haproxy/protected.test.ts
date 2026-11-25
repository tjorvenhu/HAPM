import { describe, it, expect } from 'vitest';
import { germanText, type Message } from '@/lib/i18n/translate';
import {
  WITHOUT_SURFACE_PROTECTION,
  refuseSurfaceDelete,
  refuseSurfaceScopeEntry,
  refuseSurfaceScopeRemoval,
  refuseSurfaceUpdate,
  surfaceHost,
  surfaceTarget,
} from '@/lib/haproxy/protected';

/**
 * Das Ziel, über das die Oberfläche von HAPM erreichbar ist, bleibt stehen.
 *
 * Der Fehler, um den es geht, lässt sich in der Oberfläche nicht mehr
 * beheben: wer dieses Ziel entfernt, erreicht sie danach nicht. Die Regel
 * hängt an der Adresse aus den Einstellungen und nicht an einem Namen, und
 * genau das rechnen die Fälle hier nach.
 */

const ADDRESS = 'https://hapm.example.org';

type Service = Parameters<typeof surfaceTarget>[0][number];

const SERVICES: Service[] = [
  { id: 'hapm', scope: 'HAPM', domains: ['hapm.example.org'] },
  { id: 'shop', scope: 'KUNDEN', domains: ['shop.example.org', 'www.shop.example.org'] },
];

function target(services: Service[] = SERVICES, publicUrl: string | null = ADDRESS) {
  return surfaceTarget(services, { publicUrl });
}


/** Die Meldung auf Deutsch, wie sie ohne Sprache herauskommt. */
const de = (message: Message | null) => (message ? germanText(message) : message);

describe('surfaceHost', () => {
  it('nimmt den Host aus der Adresse, klein und ohne Port', () => {
    expect(surfaceHost('https://hapm.example.org')).toBe('hapm.example.org');
    expect(surfaceHost('https://HAPM.Example.org/')).toBe('hapm.example.org');
    expect(surfaceHost('https://hapm.example.org:8443')).toBe('hapm.example.org');
  });

  it('ist ohne Adresse und bei einer, die keine ist, null', () => {
    expect(surfaceHost(null)).toBeNull();
    expect(surfaceHost(undefined)).toBeNull();
    expect(surfaceHost('')).toBeNull();
    expect(surfaceHost('hapm.example.org')).toBeNull();
  });
});

describe('surfaceTarget', () => {
  it('findet das Ziel, das die Domain der Adresse trägt', () => {
    expect(target()).toEqual({
      serviceId: 'hapm',
      scope: 'HAPM',
      host: 'hapm.example.org',
      url: ADDRESS,
    });
  });

  it('hängt nicht am Namen: ein Ziel namens hapm ohne die Domain ist keins', () => {
    const services = [
      { id: 'hapm', scope: 'HAPM', domains: ['anders.example.org'] },
      { id: 'verwaltung', scope: 'INTERN', domains: ['hapm.example.org'] },
    ];
    expect(target(services)?.serviceId).toBe('verwaltung');
    expect(target(services)?.scope).toBe('INTERN');
  });

  it('schützt nichts, solange keine Adresse eingerichtet ist', () => {
    expect(target(SERVICES, null)).toBeNull();
    expect(target(SERVICES, '')).toBeNull();
    expect(surfaceTarget(SERVICES, WITHOUT_SURFACE_PROTECTION)).toBeNull();
  });

  it('schützt nichts, wenn kein Ziel die Domain trägt', () => {
    expect(target(SERVICES, 'https://woanders.example.org')).toBeNull();
  });

  it('vergleicht ohne Rücksicht auf Groß- und Kleinschreibung', () => {
    const services = [{ id: 'hapm', scope: 'HAPM', domains: ['HAPM.Example.org'] }];
    expect(target(services, 'https://Hapm.EXAMPLE.org')?.serviceId).toBe('hapm');
  });

  it('lässt den Port der Adresse beim Vergleich weg', () => {
    expect(target(SERVICES, 'https://hapm.example.org:8443')?.serviceId).toBe('hapm');
  });

  it('trifft auch über eine Wildcard des Ziels', () => {
    const services = [{ id: 'alles', scope: 'INTERN', domains: ['example.org', '*.example.org'] }];
    expect(target(services)?.serviceId).toBe('alles');
    // Der führende Punkt ist der Riegel: eine Domain, die nur gleich endet, gehört nicht dazu.
    expect(target(services, 'https://hapm.fremdexample.org')).toBeNull();
  });

  it('nimmt bei zwei Treffern die obere Weiche, wie HAProxy', () => {
    const services = [
      { id: 'hapm', scope: 'HAPM', domains: ['hapm.example.org'] },
      { id: 'alles', scope: 'INTERN', domains: ['*.example.org'] },
    ];
    expect(target(services)?.serviceId).toBe('hapm');
    expect(target([...services].reverse())?.serviceId).toBe('alles');
  });

  it('kennt auch ein Ziel außerhalb aller Gruppen', () => {
    const services = [{ id: 'von_hand', scope: null, domains: ['hapm.example.org'] }];
    expect(target(services)).toMatchObject({ serviceId: 'von_hand', scope: null });
  });
});

describe('refuseSurfaceDelete', () => {
  it('lehnt das Entfernen des Ziels der Oberfläche ab und nennt Adresse und Ausweg', () => {
    const message = de(refuseSurfaceDelete(target(), 'hapm'));
    expect(message).toContain(ADDRESS);
    expect(message).toContain('lässt sich nicht entfernen');
    expect(message).toContain('unter Allgemein');
    // Der Ausweg ist die Adresse. Die Einrichtung lässt sich nicht erneut öffnen.
    expect(message).toContain('Danach lässt sich dieses Ziel entfernen.');
    expect(message).not.toContain('Einrichtung');
  });

  it('lässt jedes andere Ziel in Ruhe', () => {
    expect(refuseSurfaceDelete(target(), 'shop')).toBeNull();
  });

  it('lässt ohne Adresse alles zu', () => {
    expect(refuseSurfaceDelete(target(SERVICES, null), 'hapm')).toBeNull();
  });
});

describe('refuseSurfaceUpdate', () => {
  it('lehnt eine Änderung ab, nach der das Ziel die Domain nicht mehr trägt', () => {
    const message = de(refuseSurfaceUpdate(target(), 'hapm', ['neu.example.org']));
    expect(message).toContain('hapm.example.org');
    expect(message).toContain('unter Allgemein');
  });

  it('lässt weitere Domains und jede andere Änderung zu', () => {
    expect(refuseSurfaceUpdate(target(), 'hapm', ['hapm.example.org'])).toBeNull();
    expect(refuseSurfaceUpdate(target(), 'hapm', ['neu.example.org', 'HAPM.example.org'])).toBeNull();
  });

  it('lässt die Domain auch über eine Wildcard weiter gelten', () => {
    expect(refuseSurfaceUpdate(target(), 'hapm', ['example.org', '*.example.org'])).toBeNull();
  });

  it('betrifft nur das Ziel der Oberfläche', () => {
    expect(refuseSurfaceUpdate(target(), 'shop', ['neu.example.org'])).toBeNull();
  });

  it('gibt der Einrichtung den Weg frei', () => {
    const surface = surfaceTarget(SERVICES, WITHOUT_SURFACE_PROTECTION);
    expect(refuseSurfaceUpdate(surface, 'hapm', ['neu.example.org'])).toBeNull();
  });
});

describe('refuseSurfaceScopeRemoval', () => {
  it('lehnt das Entfernen der Gruppe ab, in der das Ziel liegt', () => {
    const message = de(refuseSurfaceScopeRemoval(target(), 'hapm'));
    expect(message).toContain(ADDRESS);
    expect(message).toContain('lässt sich nicht entfernen');
  });

  it('lässt andere Gruppen in Ruhe', () => {
    expect(refuseSurfaceScopeRemoval(target(), 'KUNDEN')).toBeNull();
  });

  it('schützt keine Gruppe, wenn das Ziel außerhalb aller Gruppen steht', () => {
    const services = [{ id: 'von_hand', scope: null, domains: ['hapm.example.org'] }];
    expect(refuseSurfaceScopeRemoval(target(services), 'HAPM')).toBeNull();
  });
});

describe('refuseSurfaceScopeEntry', () => {
  it('lehnt ein neues Ziel in der Gruppe der Oberfläche ab, gleich in welcher Schreibweise', () => {
    expect(refuseSurfaceScopeEntry(target(), 'HAPM', null, null)).not.toBeNull();
    expect(refuseSurfaceScopeEntry(target(), ' hapm ', null, null)).not.toBeNull();
  });

  it('lässt jede andere Gruppe zu', () => {
    expect(refuseSurfaceScopeEntry(target(), 'KUNDEN', null, null)).toBeNull();
  });

  it('lehnt den Umzug eines anderen Ziels hinein ab', () => {
    expect(refuseSurfaceScopeEntry(target(), 'HAPM', 'shop', 'KUNDEN')).not.toBeNull();
  });

  it('lässt das Ziel der Oberfläche selbst und alles, was schon darin liegt, weiter zu', () => {
    expect(refuseSurfaceScopeEntry(target(), 'HAPM', 'hapm', 'HAPM')).toBeNull();
    expect(refuseSurfaceScopeEntry(target(), 'HAPM', 'alt', 'HAPM')).toBeNull();
  });

  it('sperrt nichts ohne Adresse von HAPM', () => {
    expect(refuseSurfaceScopeEntry(target(SERVICES, null), 'HAPM', null, null)).toBeNull();
  });
});
