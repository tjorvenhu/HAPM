import { describe, it, expect } from 'vitest';
import { carriesState, refusalOf, warningsFor } from '@/lib/sync/compare';
import { adaptConfig, localVariant } from '@/lib/sync/adapt';
import type { BundleMeta } from '@/lib/sync/bundle';
import { SYNC_PROTOCOL, type NodeReport } from '@/lib/sync/types';
import { renderBaseConfig } from '@/lib/haproxy/base-config';
import {
  CROWDSEC_LINES,
  addScope,
  addService,
  applyGlobalSettings,
  parseGlobalSettings,
  parseHaproxyConfig,
  syncCrowdsecBackend,
  usesCrowdsec,
  type CreateServiceInput,
} from '@/lib/haproxy/config';

/**
 * Was ein Hauptknoten aus der Auskunft eines anderen Knotens schließt: nimmt
 * er an, was fällt auf, trägt er den Stand schon. Und wie ein Folgeknoten die
 * `haproxy.cfg` an sich anpasst.
 */

const OWN = '1'.repeat(32);
const FINGERPRINT = 'f'.repeat(64);

function report(over: Partial<NodeReport> = {}): NodeReport {
  return {
    protocol: SYNC_PROTOCOL,
    nodeId: '2'.repeat(32),
    name: 'proxy02',
    role: 'replica',
    hapmVersion: '0.6.1',
    haproxyVersion: '3.2.4',
    crowdsec: true,
    exposure: 'public',
    primary: { nodeId: OWN, name: 'proxy01' },
    applied: { fingerprint: FINGERPRINT, seq: 10, at: '2026-11-26T10:00:00.000Z', variant: 'crowdsec=an;spoa=127.0.0.1:7423' },
    variant: 'crowdsec=an;spoa=127.0.0.1:7423',
    intact: true,
    apply: null,
    ...over,
  };
}

function meta(over: Partial<BundleMeta['sender']> = {}, skipped: string[] = []): BundleMeta {
  return {
    protocol: SYNC_PROTOCOL,
    seq: 11,
    fingerprint: FINGERPRINT,
    sender: { nodeId: OWN, name: 'proxy01', hapmVersion: '0.6.1', haproxyVersion: '3.2.4', exposure: 'public', usesCrowdsec: true, ...over },
    roots: ['haproxy', 'acme'],
    skipped,
  };
}

describe('nimmt die Gegenstelle an', () => {
  it('ein Folgeknoten, der an diesen Hauptknoten gebunden ist oder noch an keinen', () => {
    expect(refusalOf(report(), OWN)).toBeNull();
    expect(refusalOf(report({ primary: null, applied: null }), OWN)).toBeNull();
  });

  it('zwei Hauptknoten gleichen nicht ab', () => {
    // Der Fall nach einem Ausfall: der Folgeknoten wurde befördert, der alte Hauptknoten kommt zurück.
    const refusal = refusalOf(report({ role: 'primary' }), OWN);
    expect(refusal).toContain('ist selbst Hauptknoten');
    expect(refusal).toContain('proxy02');
  });

  it('ein Knoten, der einzeln arbeitet, ist kein Folgeknoten', () => {
    expect(refusalOf(report({ role: 'single' }), OWN)).toContain('nicht als Folgeknoten eingerichtet');
  });

  it('ein Folgeknoten eines anderen Hauptknotens bleibt bei dem', () => {
    const refusal = refusalOf(report({ primary: { nodeId: '9'.repeat(32), name: 'proxy09' } }), OWN);
    expect(refusal).toContain('an den Hauptknoten proxy09 gebunden');
  });

  it('die eigene Adresse ist keine Gegenstelle', () => {
    // Die gemeinsame Adresse zeigt gerade auf diesen Knoten selbst.
    expect(refusalOf(report({ nodeId: OWN }), OWN)).toContain('zu diesem Knoten selbst');
  });

  it('eine andere Fassung des Abgleichs wird nicht halb verstanden', () => {
    expect(refusalOf(report({ protocol: SYNC_PROTOCOL + 1 }), OWN)).toContain('andere Fassung des Abgleichs');
  });
});

describe('was auffällt, ohne zu hindern', () => {
  it('nichts, wenn beide Knoten gleich dastehen', () => {
    expect(warningsFor(report(), meta())).toEqual([]);
  });

  it('verschiedene Fassungen von HAPM und HAProxy', () => {
    expect(warningsFor(report({ hapmVersion: '0.6.0', haproxyVersion: '3.0.9' }), meta())).toEqual([
      { code: 'hapm_version', here: '0.6.1', there: '0.6.0' },
      { code: 'haproxy_version', here: '3.2.4', there: '3.0.9' },
    ]);
  });

  it('eine unbekannte Fassung von HAProxy ist keine andere', () => {
    expect(warningsFor(report({ haproxyVersion: null }), meta())).toEqual([]);
    expect(warningsFor(report(), meta({ haproxyVersion: null }))).toEqual([]);
  });

  it('eine andere Art der Installation', () => {
    expect(warningsFor(report({ exposure: 'internal' }), meta())).toEqual([{ code: 'exposure', here: 'public', there: 'internal' }]);
  });

  it('CrowdSec nur dann, wenn die Datei es benutzt und der Folgeknoten es nicht hat', () => {
    expect(warningsFor(report({ crowdsec: false }), meta())).toEqual([{ code: 'crowdsec_off' }]);
    expect(warningsFor(report({ crowdsec: false }), meta({ usesCrowdsec: false }))).toEqual([]);
  });

  it('was beim Packen übergangen wurde', () => {
    expect(warningsFor(report(), meta({}, ['haproxy/verweis.cfg', 'acme/socket']))).toEqual([{ code: 'skipped', count: 2 }]);
  });
});

describe('trägt der Folgeknoten den Stand', () => {
  it('ja, bei gleichem Fingerabdruck, gleicher Anpassung und unberührten Dateien', () => {
    expect(carriesState(report(), FINGERPRINT)).toBe(true);
    // Nicht zu sagen ist nicht „geändert".
    expect(carriesState(report({ intact: null }), FINGERPRINT)).toBe(true);
  });

  it('nein, wenn er noch nie etwas übernommen hat', () => {
    expect(carriesState(report({ applied: null }), FINGERPRINT)).toBe(false);
  });

  it('nein, wenn sich hier etwas geändert hat', () => {
    expect(carriesState(report(), '0'.repeat(64))).toBe(false);
  });

  it('nein, wenn dort jemand Dateien geändert hat', () => {
    expect(carriesState(report({ intact: false }), FINGERPRINT)).toBe(false);
  });

  it('nein, wenn er das Paket inzwischen anders anpassen würde', () => {
    // CrowdSec wurde dort eingeschaltet: dieselbe Datei ergäbe dort jetzt eine andere.
    expect(carriesState(report({ variant: 'crowdsec=aus;spoa=127.0.0.1:7423' }), FINGERPRINT)).toBe(false);
  });
});

function service(id: string, domain: string, crowdsec: boolean): CreateServiceInput {
  return {
    scope: 'WEB',
    id,
    domains: [domain],
    servers: [{ name: 'ziel', target: '10.0.0.5:8080', weight: null }],
    redirect: null,
    routes: [],
    balance: null,
    sticky: false,
    lockedDomains: [],
    passwordLock: null,
    responseHeaders: [],
    requestHeaders: [],
    tunnel: false,
    crowdsec,
    app: null,
    healthcheck: false,
    backendTls: 'off',
  };
}

/** Eine `haproxy.cfg`, wie HAPM sie schreibt: ein Ziel mit CrowdSec, eines ohne, dazu der globale Schalter. */
function primaryConfig(global: boolean): string {
  let text = addScope(renderBaseConfig({ ipv6: false, errorStatuses: [403, 404] }), 'WEB');
  text = addService(text, service('shop', 'shop.example.org', true));
  text = addService(text, service('blog', 'blog.example.org', false));
  const current = parseGlobalSettings(text);
  text = applyGlobalSettings(text, { httpsLines: current.httpsLines ?? [], adminIps: [], crowdsec: global });
  return syncCrowdsecBackend(text, '127.0.0.1:7423');
}

describe('die haproxy.cfg an den Folgeknoten anpassen', () => {
  it('lässt sie, wie sie ist, wenn der Knoten CrowdSec hat und denselben Port', () => {
    const text = primaryConfig(true);
    expect(adaptConfig(text, { crowdsec: true, spoaAddress: '127.0.0.1:7423' })).toEqual({ text, crowdsec: 'kept' });
  });

  it('nimmt CrowdSec heraus, wenn der Knoten es nicht hat: aus den Zielen, global und das Backend des Bouncers', () => {
    for (const global of [false, true]) {
      const text = primaryConfig(global);
      expect(usesCrowdsec(text)).toBe(true);
      const adapted = adaptConfig(text, { crowdsec: false, spoaAddress: '127.0.0.1:7423' });
      expect(adapted.crowdsec).toBe('removed');
      expect(usesCrowdsec(adapted.text)).toBe(false);
      for (const line of CROWDSEC_LINES) expect(adapted.text).not.toContain(line);
      expect(adapted.text).not.toContain('hapm_crowdsec_spoa');
      expect(parseGlobalSettings(adapted.text).crowdsec).toBe(false);
    }
  });

  it('lässt dabei jedes Ziel stehen', () => {
    const text = primaryConfig(true);
    const adapted = adaptConfig(text, { crowdsec: false, spoaAddress: '127.0.0.1:7423' });
    const before = parseHaproxyConfig(text).map((entry) => ({ id: entry.id, domains: entry.domains, servers: entry.servers }));
    const after = parseHaproxyConfig(adapted.text).map((entry) => ({ id: entry.id, domains: entry.domains, servers: entry.servers }));
    expect(after).toEqual(before);
    expect(parseHaproxyConfig(adapted.text).every((entry) => entry.crowdsec === false)).toBe(true);
  });

  it('meldet, wenn es sich nicht herausnehmen lässt, und lässt die Datei dann unberührt', () => {
    // Ohne den Marker der globalen Einstellungen weiß HAPM nicht, wo es schreiben dürfte.
    const text = primaryConfig(false).replace('# Globale HTTPS-Settings', '# von Hand umbenannt');
    expect(adaptConfig(text, { crowdsec: false, spoaAddress: '127.0.0.1:7423' })).toEqual({ text, crowdsec: 'stuck' });
  });

  it('nennt, woran die Anpassung hängt', () => {
    expect(localVariant({ crowdsec: true, spoaAddress: '127.0.0.1:7423' })).not.toBe(localVariant({ crowdsec: false, spoaAddress: '127.0.0.1:7423' }));
    expect(localVariant({ crowdsec: true, spoaAddress: '127.0.0.1:7423' })).not.toBe(localVariant({ crowdsec: true, spoaAddress: '127.0.0.1:7999' }));
  });
});
