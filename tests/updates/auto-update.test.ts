import { describe, it, expect } from 'vitest';
import { DEFAULT_AUTO_UPDATE, settingsPatch, withDefaults } from '@/lib/settings';

/**
 * Selbsttätige Updates je Bestandteil. Eine neue Installation aktualisiert
 * alles außer HAPM; eine Zeile von vor der Auswahl behält ihre Entscheidung für
 * HAProxy, die übrigen bekommen die neue Vorgabe.
 */

const encrypt = (text: string) => text;

describe('withDefaults: autoUpdate', () => {
  it('nimmt für eine neue Installation alles außer HAPM', () => {
    const settings = withDefaults({});
    expect(settings.autoUpdate).toEqual(['acme', 'crowdsec', 'crowdsec-bouncer', 'haproxy']);
    expect(settings.autoUpdate).not.toContain('hapm');
    expect(settings.autoUpdateHaproxy).toBe(true);
    expect([...DEFAULT_AUTO_UPDATE].sort()).toEqual([...settings.autoUpdate].sort());
  });

  it('behält HAProxy aus einer alten Zeile, wie es war', () => {
    // `autoUpdate` fehlt in der Zeile: sie stammt von vor der Auswahl.
    const off = withDefaults({ autoUpdateHaproxy: false, autoUpdate: undefined });
    expect(off.autoUpdate).toEqual(['acme', 'crowdsec', 'crowdsec-bouncer']);
    expect(off.autoUpdateHaproxy).toBe(false);
    const on = withDefaults({ autoUpdateHaproxy: true, autoUpdate: undefined });
    expect(on.autoUpdate).toContain('haproxy');
  });

  it('liest eine gespeicherte Liste in fester Reihenfolge, HAPM zuletzt, ohne Unbekanntes', () => {
    const settings = withDefaults({ autoUpdate: ['hapm', 'haproxy', 'nichts' as never] });
    expect(settings.autoUpdate).toEqual(['haproxy', 'hapm']);
  });
});

describe('settingsPatch: autoUpdate', () => {
  const current = withDefaults({ autoUpdate: ['haproxy', 'acme'] });

  it('setzt die Liste und den alten Schalter mit', () => {
    const patch = settingsPatch({ autoUpdate: ['crowdsec', 'hapm'] }, current, encrypt);
    expect(patch.autoUpdate).toEqual(['crowdsec', 'hapm']);
    expect(patch.autoUpdateHaproxy).toBe(false);
  });

  it('der alte Schalter nimmt nur HAProxy heraus oder dazu', () => {
    expect(settingsPatch({ autoUpdateHaproxy: false }, current, encrypt).autoUpdate).toEqual(['acme']);
    const added = settingsPatch({ autoUpdateHaproxy: true }, withDefaults({ autoUpdate: ['acme'] }), encrypt);
    expect(added.autoUpdate).toEqual(['acme', 'haproxy']);
  });

  it('eine leere Liste schaltet alles ab', () => {
    expect(settingsPatch({ autoUpdate: [] }, current, encrypt).autoUpdate).toEqual([]);
  });
});
