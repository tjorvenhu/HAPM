import { describe, it, expect } from 'vitest';
import { renderBaseConfig } from '@/lib/haproxy/base-config';
import {
  CROWDSEC_LINES,
  CROWDSEC_MARKER,
  CROWDSEC_SPOA_BACKEND,
  CROWDSEC_SPOE_FILE,
  addScope,
  addService,
  applyGlobalSettings,
  crowdsecSpoeConfig,
  parseCrowdsecGlobal,
  parseGlobalSettings,
  parseHaproxyConfig,
  readGlobalSettingsInput,
  readGlobalSettingsPatch,
  readServiceInput,
  removeService,
  replaceService,
  syncCrowdsecBackend,
  toCreateInput,
  usesCrowdsec,
  validateCreateInput,
  type CreateServiceInput,
} from '@/lib/haproxy/config';
import { diffBaseConfig } from '@/lib/haproxy/base-config-diff';

/**
 * CrowdSec steht in der Datei wie jeder andere Zusatz: als feste Zeilen, die
 * HAPM schreibt und genau so zurückliest. Global im HTTPS-Frontend, je Ziel in
 * jedem seiner Backends. Ob HAProxy die Zeilen annimmt, prüft
 * `scripts/verify-crowdsec.ts` gegen echtes HAProxy, CrowdSec und den Bouncer.
 */

const OPTIONS = { ipv6: false, errorStatuses: [403, 404] };
const BASE = addScope(renderBaseConfig(OPTIONS), 'WEB');
const ADDRESS = '127.0.0.1:7423';

const SERVICE: CreateServiceInput = {
  scope: 'WEB',
  id: 'shop',
  domains: ['shop.example.org'],
  servers: [{ name: 'shop', target: '10.0.0.5:8080', weight: null }],
  redirect: null,
  routes: [],
  balance: null,
  sticky: false,
  lockedDomains: [],
  passwordLock: null,
  responseHeaders: [],
  requestHeaders: [],
  tunnel: false,
  crowdsec: true,
  healthcheck: true,
  backendTls: 'off',
};

const find = (text: string, id: string) => parseHaproxyConfig(text).find((s) => s.id === id)!;

function settingsInput(text: string, crowdsec?: boolean) {
  const current = parseGlobalSettings(text);
  return { httpsLines: current.httpsLines ?? [], adminIps: current.adminIps, ...(crowdsec === undefined ? {} : { crowdsec }) };
}

describe('CrowdSec je Ziel', () => {
  it('steht in jedem Backend des Ziels, auch in denen der Pfad-Regeln', () => {
    const input: CreateServiceInput = {
      ...SERVICE,
      routes: [{ name: 'ws', paths: ['/ws'], servers: [{ name: 'server1', target: '10.0.0.5:6001' }], check: true, backendTls: 'off' }],
    };
    const text = addService(BASE, input);
    const lines = text.split('\n');
    for (const backend of ['backend shop', 'backend shop_ws']) {
      const start = lines.indexOf(backend);
      expect(start, backend).toBeGreaterThan(-1);
      let end = start + 1;
      while (end < lines.length && !/^(backend|frontend|listen|# AUTO)/.test(lines[end])) end++;
      const block = lines.slice(start, end).map((line) => line.trim());
      expect(block.filter((line) => CROWDSEC_LINES.includes(line)), backend).toEqual([...CROWDSEC_LINES]);
    }
    const service = find(text, 'shop');
    expect(service.crowdsec).toBe(true);
    expect(service.editable).toBe(true);
    expect(service.extras).toEqual([]);
    expect(toCreateInput(service)).toEqual(input);
  });

  it('ist aus, wenn die Zeilen fehlen, und lässt sich ab- und wieder einschalten', () => {
    const on = addService(BASE, SERVICE);
    const off = replaceService(on, 'shop', { ...SERVICE, crowdsec: false });
    expect(find(off, 'shop').crowdsec).toBe(false);
    expect(usesCrowdsec(off)).toBe(false);
    const again = replaceService(off, 'shop', SERVICE);
    expect(find(again, 'shop').crowdsec).toBe(true);
  });

  it('zählt nur vollständig: eine halbe Fassung ist von Hand und macht das Ziel nur lesbar', () => {
    const text = addService(BASE, SERVICE).replace(`    ${CROWDSEC_LINES[6]}\n`, '');
    const service = find(text, 'shop');
    expect(service.crowdsec).toBe(false);
    expect(service.editable).toBe(false);
    expect(service.extras).toContain(CROWDSEC_LINES[0]);
  });

  it('geht beim Löschen des Ziels mit', () => {
    const text = removeService(addService(BASE, SERVICE), 'shop');
    expect(usesCrowdsec(text)).toBe(false);
  });

  it('gibt es nicht bei einer Weiterleitung', () => {
    const redirect: CreateServiceInput = {
      ...SERVICE,
      servers: [],
      healthcheck: false,
      redirect: { to: 'https://example.org', keepPath: false, permanent: false },
    };
    expect(validateCreateInput(redirect)).not.toBeNull();
    // Die Route normalisiert statt abzulehnen: das Formular zeigt die Frage nicht.
    expect(readServiceInput({ ...redirect, crowdsec: true }).crowdsec).toBe(false);
  });
});

describe('CrowdSec global', () => {
  it('fehlt in der Grundkonfiguration', () => {
    expect(parseCrowdsecGlobal(BASE)).toBe(false);
    expect(parseGlobalSettings(BASE).crowdsec).toBe(false);
  });

  it('steht nach dem Einschalten im HTTPS-Frontend vor den Diensten und lässt sich wieder entfernen', () => {
    const withService = addService(BASE, { ...SERVICE, crowdsec: false });
    const on = applyGlobalSettings(withService, settingsInput(withService, true));
    expect(parseCrowdsecGlobal(on)).toBe(true);
    const lines = on.split('\n');
    const marker = lines.findIndex((line) => line.trim() === CROWDSEC_MARKER);
    const https = lines.findIndex((line) => line.startsWith('frontend public_https'));
    const firstService = lines.findIndex((line) => line.includes('acl host_shop'));
    expect(marker).toBeGreaterThan(https);
    expect(marker).toBeLessThan(firstService);
    // Die HTTPS-Zeilen bleiben, was sie waren.
    expect(parseGlobalSettings(on).httpsLines).toEqual(parseGlobalSettings(withService).httpsLines);

    const off = applyGlobalSettings(on, settingsInput(on, false));
    expect(parseCrowdsecGlobal(off)).toBe(false);
    expect(off).toBe(withService);
  });

  it('bleibt beim Speichern der Einstellungen ohne Feld, wie es ist', () => {
    const on = applyGlobalSettings(BASE, settingsInput(BASE, true));
    const saved = applyGlobalSettings(on, settingsInput(on));
    expect(parseCrowdsecGlobal(saved)).toBe(true);
  });

  it('steht hinter dem Zugriffsschutz, wenn es den gibt', () => {
    const protectedText = applyGlobalSettings(BASE, {
      ...settingsInput(BASE),
      protection: { blockedIps: ['203.0.113.7'], blockedCountries: [], rateLimit: null },
    });
    const on = applyGlobalSettings(protectedText, settingsInput(protectedText, true));
    expect(on.indexOf(CROWDSEC_MARKER)).toBeGreaterThan(on.indexOf('# Zugriffsschutz'));
    expect(parseGlobalSettings(on).protection?.blockedIps).toEqual(['203.0.113.7']);
  });

  it('fasst einen von Hand geänderten Block nicht an', () => {
    const on = applyGlobalSettings(BASE, settingsInput(BASE, true));
    const edited = on.replace(CROWDSEC_LINES[3], 'http-request wait-for-body time 2s at-least 8k unless hapm_crowdsec_done');
    expect(parseCrowdsecGlobal(edited)).toBeNull();
    expect(() => applyGlobalSettings(edited, settingsInput(edited, false))).toThrow();
    // Ohne Feld bleibt er stehen.
    expect(applyGlobalSettings(edited, settingsInput(edited))).toContain('time 2s');
  });

  it('wird aus Formular und Teil-Patch gelesen, ohne Feld gar nicht', () => {
    expect(readGlobalSettingsInput({ httpsLines: [], adminIps: [], crowdsec: true }).crowdsec).toBe(true);
    expect('crowdsec' in readGlobalSettingsInput({ httpsLines: [], adminIps: [] })).toBe(false);
    const patch = readGlobalSettingsPatch({ crowdsec: false }, parseGlobalSettings(BASE));
    expect('error' in patch ? null : patch.crowdsec).toBe(false);
  });

  it('stört den Abgleich mit der Grundkonfiguration nicht', () => {
    const on = syncCrowdsecBackend(applyGlobalSettings(BASE, settingsInput(BASE, true)), ADDRESS);
    expect(diffBaseConfig(on, OPTIONS).drifts).toEqual(diffBaseConfig(BASE, OPTIONS).drifts);
  });
});

describe('syncCrowdsecBackend', () => {
  it('legt das Backend des Bouncers an, sobald etwas CrowdSec benutzt', () => {
    const text = syncCrowdsecBackend(addService(BASE, SERVICE), ADDRESS);
    expect(text).toContain(`backend ${CROWDSEC_SPOA_BACKEND}`);
    expect(text).toContain(`server bouncer ${ADDRESS} check`);
    // Ein zweites Mal ändert nichts.
    expect(syncCrowdsecBackend(text, ADDRESS)).toBe(text);
  });

  it('entfernt es, sobald nichts mehr CrowdSec benutzt', () => {
    const on = syncCrowdsecBackend(addService(BASE, SERVICE), ADDRESS);
    const off = syncCrowdsecBackend(removeService(on, 'shop'), ADDRESS);
    expect(off).not.toContain(CROWDSEC_SPOA_BACKEND);
    expect(off.trimEnd()).toBe(BASE.trimEnd());
  });

  it('lässt ein Backend ohne Marker stehen: das hat jemand von Hand geschrieben', () => {
    const manual = `${BASE}\nbackend ${CROWDSEC_SPOA_BACKEND}\n    mode tcp\n    server bouncer 127.0.0.1:9000\n`;
    expect(syncCrowdsecBackend(manual, ADDRESS)).toBe(manual);
  });

  it('ändert nichts ohne CrowdSec', () => {
    expect(syncCrowdsecBackend(BASE, ADDRESS)).toBe(BASE);
  });
});

describe('crowdsecSpoeConfig', () => {
  it('nennt die Nachrichten, die der Bouncer kennt, und das Backend', () => {
    const spoe = crowdsecSpoeConfig();
    expect(spoe).toContain('spoe-message crowdsec-http-body');
    expect(spoe).toContain('spoe-message crowdsec-http-no-body');
    expect(spoe).toContain(`use-backend ${CROWDSEC_SPOA_BACKEND}`);
    expect(spoe).toContain('option var-prefix crowdsec');
    expect(CROWDSEC_LINES[0]).toContain(CROWDSEC_SPOE_FILE);
  });
});
