import { describe, it, expect } from 'vitest';
import {
  normalizeDomain,
  zoneCovers,
  matchZone,
  isZoneApex,
  recordName,
  recordFqdn,
  proxyRecordPlan,
  isProxyRecord,
  validateZoneName,
  isWildcardDomain,
  selectedDnsDomains,
  suggestDomains,
} from '@/lib/dns/zones';

/**
 * Die Zuordnung Domain → Zone entscheidet, in welche fremde Zone geschrieben
 * wird. Deshalb steht hier die Suffix-Falle an erster Stelle: sie ist dieselbe,
 * gegen die die HAProxy-ACL `-m end -i .kunde.example` den führenden Punkt trägt.
 */

describe('normalizeDomain', () => {
  it('macht aus den drei Schreibweisen derselben Domain eine', () => {
    expect(normalizeDomain(' Kunde.EXAMPLE ')).toBe('kunde.example');
    // Cloudflare gibt den Namen mit abschließendem Punkt zurück.
    expect(normalizeDomain('kunde.example.')).toBe('kunde.example');
  });
});

describe('zoneCovers', () => {
  it('trifft die Zone selbst und alles darunter', () => {
    expect(zoneCovers('kunde.example', 'kunde.example')).toBe(true);
    expect(zoneCovers('kunde.example', 'app.kunde.example')).toBe(true);
    expect(zoneCovers('kunde.example', 'a.b.kunde.example')).toBe(true);
  });

  it('trifft NICHT die Domain, die den Namen nur enthält', () => {
    expect(zoneCovers('kunde.example', 'fremdekunde.example')).toBe(false);
    expect(zoneCovers('kunde.example', 'app.fremdekunde.example')).toBe(false);
  });

  it('rechnet die Wildcard auf ihre Basis herunter', () => {
    expect(zoneCovers('kunde.example', '*.kunde.example')).toBe(true);
    expect(isWildcardDomain('*.kunde.example')).toBe(true);
  });
});

describe('matchZone', () => {
  const zones = [{ name: 'kunde.example' }, { name: 'intern.kunde.example' }, { name: 'example.org' }];

  it('nimmt die speziellere Zone, nicht die erste passende', () => {
    expect(matchZone('app.intern.kunde.example', zones)?.name).toBe('intern.kunde.example');
    expect(matchZone('app.kunde.example', zones)?.name).toBe('kunde.example');
  });

  it('gibt null, wenn keine Zone die Domain trägt', () => {
    expect(matchZone('example.com', zones)).toBeNull();
    expect(matchZone('fremdekunde.example', zones)).toBeNull();
  });
});

describe('recordName / recordFqdn', () => {
  it('rechnet zwischen vollem und relativem Namen hin und her', () => {
    expect(recordName('app.kunde.example', 'kunde.example')).toBe('app');
    expect(recordName('a.b.kunde.example', 'kunde.example')).toBe('a.b');
    expect(recordName('kunde.example', 'kunde.example')).toBe('@');
    expect(recordFqdn('app', 'kunde.example')).toBe('app.kunde.example');
    expect(recordFqdn('@', 'kunde.example')).toBe('kunde.example');
    // Wer den vollen Namen eingibt, bekommt ihn nicht doppelt zurück.
    expect(recordFqdn('app.kunde.example', 'kunde.example')).toBe('app.kunde.example');
  });

  it('erkennt die Zone selbst, auch als Wildcard-Basis', () => {
    expect(isZoneApex('kunde.example', 'kunde.example')).toBe(true);
    expect(isZoneApex('app.kunde.example', 'kunde.example')).toBe(false);
  });
});

describe('proxyRecordPlan', () => {
  it('ist ein CNAME auf die Zone selbst, ohne Cloudflare-Proxy', () => {
    const plan = proxyRecordPlan('app.kunde.example', 'kunde.example');
    expect(plan).toEqual({
      type: 'CNAME',
      name: 'app',
      fqdn: 'app.kunde.example',
      content: 'kunde.example',
      proxied: false,
      ttl: 1,
    });
  });

  it('trägt die Wildcard als Namen `*`', () => {
    expect(proxyRecordPlan('*.kunde.example', 'kunde.example')?.name).toBe('*');
  });

  it('gibt für die Zone selbst nichts zurück — dort steht der A-Eintrag von Hand', () => {
    expect(proxyRecordPlan('kunde.example', 'kunde.example')).toBeNull();
  });

  it('gibt nichts zurück, wenn die Domain gar nicht in der Zone liegt', () => {
    expect(proxyRecordPlan('app.fremdekunde.example', 'kunde.example')).toBeNull();
  });
});

describe('isProxyRecord', () => {
  it('erkennt genau den Eintrag, den das Werkzeug setzt', () => {
    expect(isProxyRecord({ type: 'CNAME', content: 'kunde.example' }, 'kunde.example')).toBe(true);
    expect(isProxyRecord({ type: 'CNAME', content: 'kunde.example.' }, 'kunde.example')).toBe(true);
  });

  it('lässt fremde Einträge in Ruhe — das ist die Bedingung fürs Löschen', () => {
    expect(isProxyRecord({ type: 'A', content: '203.0.113.10' }, 'kunde.example')).toBe(false);
    expect(isProxyRecord({ type: 'CNAME', content: 'woanders.example' }, 'kunde.example')).toBe(false);
  });
});

describe('selectedDnsDomains', () => {
  const domains = ['kunde.example', 'app.kunde.example'];

  it('nimmt nur, was auch als Domain am Dienst steht', () => {
    expect(selectedDnsDomains(['app.kunde.example'], domains)).toEqual(['app.kunde.example']);
    // Der Riegel: die Liste kommt aus dem Browser.
    expect(selectedDnsDomains(['fremde.example'], domains)).toEqual([]);
    expect(selectedDnsDomains(['APP.Kunde.example '], domains)).toEqual(['app.kunde.example']);
  });

  it('verträgt einen fehlenden oder falschen Wert im Rumpf', () => {
    expect(selectedDnsDomains(undefined, domains)).toEqual([]);
    expect(selectedDnsDomains('app.kunde.example', domains)).toEqual([]);
  });

  it('liefert jede Domain höchstens einmal', () => {
    expect(selectedDnsDomains(['app.kunde.example', 'app.kunde.example'], domains)).toEqual(['app.kunde.example']);
  });
});

describe('validateZoneName', () => {
  it('nimmt eine Domain an', () => {
    expect(validateZoneName('example.org')).toBeNull();
    expect(validateZoneName(' Example.NET ')).toBeNull();
  });

  it('weist ab, was in jeden Suffixvergleich eingeht und keiner sein darf', () => {
    expect(validateZoneName('')).toMatch(/Domain angeben/);
    expect(validateZoneName('de')).toMatch(/Punkt fehlt/);
    expect(validateZoneName('*.kunde.example')).toMatch(/Wildcard/);
    expect(validateZoneName('kunde.example/pfad')).toMatch(/Erlaubt sind/);
  });
});

describe('suggestDomains', () => {
  const zones = ['kunde.example', 'huether.example'];

  it('hängt an einen Namen ohne Punkt jede Zone', () => {
    expect(suggestDomains('app', zones)).toEqual(['app.kunde.example', 'app.huether.example']);
  });

  it('schlägt die Zone selbst vor, wenn das Getippte ihr Anfang ist', () => {
    expect(suggestDomains('kun', zones)).toEqual(['kunde.example', 'kun.kunde.example', 'kun.huether.example']);
  });

  it('nimmt mit Punkt nur Zonen, die mit dem Teil dahinter beginnen', () => {
    expect(suggestDomains('app.hu', zones)).toEqual(['app.huether.example']);
    expect(suggestDomains('app.', zones)).toEqual(['app.kunde.example', 'app.huether.example']);
    expect(suggestDomains('a.b.kunde.ex', zones)).toEqual(['a.b.kunde.example']);
    expect(suggestDomains('app.other', zones)).toEqual([]);
  });

  it('schlägt nichts vor, was schon vollständig in einer Zone liegt', () => {
    expect(suggestDomains('app.kunde.example', zones)).toEqual([]);
    expect(suggestDomains('kunde.example', ['kunde.example'])).toEqual([]);
  });

  it('leeres Feld: jede Zone mit führendem Punkt, der Name fehlt noch', () => {
    expect(suggestDomains('', zones)).toEqual(['.kunde.example', '.huether.example']);
    expect(suggestDomains('  ', [])).toEqual([]);
  });

  it('kennt Wildcards und Groß- und Kleinschreibung, und lässt Unsinn aus', () => {
    expect(suggestDomains('*', ['kunde.example'])).toEqual(['*.kunde.example']);
    expect(suggestDomains('APP', ['Kunde.Example.'])).toEqual(['app.kunde.example']);
    expect(suggestDomains('app kunde', zones)).toEqual([]);
    expect(suggestDomains('https://app', zones)).toEqual([]);
  });

  it('begrenzt die Liste', () => {
    const many = Array.from({ length: 20 }, (_, i) => `zone${i}.example`);
    expect(suggestDomains('app', many)).toHaveLength(6);
  });
});
