import { describe, it, expect } from 'vitest';
import {
  SYNCED_SETTINGS,
  SyncDataError,
  canonical,
  crowdsecFingerprint,
  dataFingerprint,
  parseSyncData,
  planAllowlist,
  planBans,
  type SyncData,
} from '@/lib/sync/data';
import { changesSyncedData } from '@/lib/sync/kick';
import { AUDIT_ACTIONS } from '@/lib/audit-log/labels';
import { sampleSyncData } from '../helpers/sync-data';

/**
 * Der Datenteil eines Pakets (`lib/sync/data.ts`): wann zwei Stände als
 * derselbe gelten, was ein Folgeknoten als Datenteil annimmt, und was er an
 * seinem CrowdSec tut, damit es zu dem des Hauptknotens passt.
 */

const NOW = Date.parse('2026-11-26T10:00:00.000Z');
const HOUR = 3_600_000;
const at = (offset: number) => new Date(NOW + offset).toISOString();

describe('der Fingerabdruck der Daten', () => {
  it('hängt nicht an der Reihenfolge, in der gelesen wurde', () => {
    const a = sampleSyncData();
    const b = sampleSyncData();
    b.accounts.users.reverse();
    b.accounts.accounts.reverse();
    b.accounts.twoFactor[0].recoveryCodes.reverse();
    expect(dataFingerprint(b)).toBe(dataFingerprint(a));
    expect(canonical({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonical({ a: [2, { c: 2, d: 1 }], b: 1 }));
  });

  it('ändert sich mit jedem Teil, der übertragen wird', () => {
    const base = dataFingerprint(sampleSyncData());
    const changed = (change: (data: SyncData) => void) => {
      const data = sampleSyncData();
      change(data);
      return dataFingerprint(data);
    };
    expect(changed((data) => (data.accounts.accounts[0].password = 'salz:anders'))).not.toBe(base);
    expect(changed((data) => data.accounts.users.pop() && data.accounts.accounts.pop())).not.toBe(base);
    expect(changed((data) => (data.accounts.twoFactor[0].enabled = false))).not.toBe(base);
    expect(changed((data) => (data.accounts.twoFactor[0].recoveryCodes = ['h1']))).not.toBe(base);
    expect(changed((data) => (data.accounts.passkeys[0].name = 'Telefon'))).not.toBe(base);
    expect(changed((data) => (data.settings.smtpPass = 'neu'))).not.toBe(base);
    expect(changed((data) => (data.settings.notifyRecipients = []))).not.toBe(base);
    expect(changed((data) => (data.dnsZones[0].access = 'token-b'))).not.toBe(base);
    expect(changed((data) => (data.serviceTokens[0].allowedIps = '10.0.0.0/8'))).not.toBe(base);
  });

  it('zählt nicht mit, was jeder Knoten für sich führt', () => {
    const base = dataFingerprint(sampleSyncData());
    const data = sampleSyncData();
    // Jede Anmeldung mit einem Passkey erhöht seinen Zähler.
    data.accounts.passkeys[0].counter = 99;
    // CrowdSec hat einen eigenen Fingerabdruck.
    data.crowdsec = null;
    expect(dataFingerprint(data)).toBe(base);
  });

  it('nennt jede Einstellung, die übertragen wird, und keine, die je Knoten gilt', () => {
    expect(SYNCED_SETTINGS).not.toContain('autoUpdate');
    expect(SYNCED_SETTINGS).not.toContain('autoUpdateTime');
    expect(SYNCED_SETTINGS).not.toContain('setupStatus');
    expect(Object.keys(sampleSyncData().settings).sort()).toEqual([...SYNCED_SETTINGS, 'smtpPass'].sort());
  });
});

describe('der Fingerabdruck von CrowdSec', () => {
  const base = () => sampleSyncData().crowdsec!;

  it('bleibt gleich, wenn nur das gerechnete Ende einer Sperre schwankt', () => {
    const later = base();
    later.bans[0].until = '2026-12-20T09:59:58.412Z';
    expect(crowdsecFingerprint(later)).toBe(crowdsecFingerprint(base()));
  });

  it('ändert sich mit einer neuen Sperre, einer neu gesetzten, einer Freigabe und den Regeln', () => {
    const print = crowdsecFingerprint(base());
    const changed = (change: (crowdsec: NonNullable<SyncData['crowdsec']>) => void) => {
      const crowdsec = base();
      change(crowdsec);
      return crowdsecFingerprint(crowdsec);
    };
    expect(changed((c) => c.bans.push({ value: '203.0.113.9', scope: 'ip', reason: 'x', createdAt: at(0), until: at(HOUR) }))).not.toBe(print);
    // Dieselbe Adresse, neu gesperrt: ein anderer Zeitpunkt.
    expect(changed((c) => (c.bans[0].createdAt = at(0)))).not.toBe(print);
    expect(changed((c) => (c.bans = []))).not.toBe(print);
    expect(changed((c) => (c.allowlist[0].expiresAt = at(HOUR)))).not.toBe(print);
    expect(changed((c) => (c.crs = 'off'))).not.toBe(print);
    expect(changed((c) => (c.collections = []))).not.toBe(print);
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any -- der Datenteil kommt als ungeprüftes JSON an */
describe('was als Datenteil angenommen wird', () => {
  const parse = (change: (data: Record<string, any>) => void) => {
    const data = JSON.parse(JSON.stringify(sampleSyncData())) as Record<string, any>;
    change(data);
    return () => parseSyncData(data);
  };

  it('ein Datenteil, wie ihn ein Hauptknoten packt, unverändert', () => {
    const data = sampleSyncData();
    const parsed = parseSyncData(JSON.parse(JSON.stringify(data)));
    expect(parsed).toEqual(data);
    expect(dataFingerprint(parsed)).toBe(dataFingerprint(data));
  });

  it('ohne CrowdSec, wenn der Hauptknoten keines hat', () => {
    expect(parse((data) => (data.crowdsec = null))().crowdsec).toBeNull();
  });

  it('nichts, was die Typen nicht nennen', () => {
    const parsed = parse((data) => {
      data.accounts.users[0].role = 'admin';
      data.settings.setupStatus = 'open';
      data.settings.autoUpdateTime = '00:00';
      data.sessions = [{ token: 'x' }];
    })() as unknown as Record<string, any>;
    expect(parsed.accounts.users[0]).not.toHaveProperty('role');
    expect(parsed.settings).not.toHaveProperty('setupStatus');
    expect(parsed.settings).not.toHaveProperty('autoUpdateTime');
    expect(parsed).not.toHaveProperty('sessions');
  });

  it('kein Datenteil, nach dem sich niemand mehr anmelden könnte', () => {
    expect(parse((data) => (data.accounts.users = []))).toThrow(/kein Konto/);
    expect(parse((data) => data.accounts.accounts.forEach((account: any) => (account.password = null)))).toThrow(/kein Konto mit Passwort/);
    expect(parse((data) => (data.accounts.accounts = []))).toThrow(SyncDataError);
  });

  it('keine Zeile, die an einem Konto hängt, das nicht im Datenteil steht', () => {
    expect(parse((data) => (data.accounts.accounts[0].userId = 'fremd'))).toThrow(/Konto dazu/);
    expect(parse((data) => (data.accounts.passkeys[0].userId = 'fremd'))).toThrow(/Konto dazu/);
    expect(parse((data) => (data.accounts.twoFactor[0].userId = 'fremd'))).toThrow(/Konto dazu/);
  });

  it('nichts doppelt', () => {
    expect(parse((data) => (data.accounts.users[1].id = 'user-a'))).toThrow(/doppelt/);
    expect(parse((data) => (data.accounts.users[1].email = 'ADA@example.org'))).toThrow(/doppelt/);
    expect(parse((data) => data.dnsZones.push({ ...data.dnsZones[0], id: 'zone-b' }))).toThrow(/doppelt/);
    expect(parse((data) => data.serviceTokens.push({ ...data.serviceTokens[0], id: 'tok-b' }))).toThrow(/doppelt/);
  });

  it('nichts in der falschen Form', () => {
    expect(() => parseSyncData(null)).toThrow(SyncDataError);
    expect(() => parseSyncData([])).toThrow(SyncDataError);
    expect(parse((data) => delete data.dnsZones)).toThrow(/DNS-Zonen/);
    expect(parse((data) => (data.serviceTokens[0].tokenHash = 'kein-hash'))).toThrow(/Hash/);
    expect(parse((data) => delete data.settings.exposure)).toThrow(/exposure/);
    expect(parse((data) => (data.settings.smtpPort = '587'))).toThrow(SyncDataError);
    expect(parse((data) => (data.settings.notifyRecipients = 'ops@example.org'))).toThrow(/Empfänger/);
    expect(parse((data) => (data.crowdsec.bans[0].scope = 'country'))).toThrow(/weder Adresse noch Netz/);
    expect(parse((data) => (data.accounts.twoFactor[0].recoveryCodes = 'h1'))).toThrow(/Wiederherstellungscodes/);
  });

  it('ein Geheimnis, das der Hauptknoten nicht lesen konnte, als solches', () => {
    const parsed = parse((data) => {
      data.accounts.twoFactor[0].secret = null;
      data.dnsZones[0].access = null;
      data.settings.smtpPass = null;
    })();
    expect(parsed.accounts.twoFactor[0].secret).toBeNull();
    expect(parsed.dnsZones[0].access).toBeNull();
    expect(parsed.settings.smtpPass).toBeNull();
  });
});

describe('Sperren von Hand auf dem Folgeknoten', () => {
  const ban = (value: string, until: string, createdAt = at(-HOUR)) => ({ value, scope: 'ip' as const, reason: 'Gesperrt in HAPM', createdAt, until });

  it('setzt, was fehlt, mit der Restdauer', () => {
    expect(planBans([ban('203.0.113.7', at(4 * HOUR))], [], NOW)).toEqual({
      remove: [],
      add: [{ value: '203.0.113.7', scope: 'ip', reason: 'Gesperrt in HAPM', seconds: 4 * 3600 }],
    });
  });

  it('lässt stehen, was schon so gesperrt ist', () => {
    // Das Ende ist gerechnet und liegt auf zwei Knoten nie auf die Sekunde gleich.
    expect(planBans([ban('203.0.113.7', at(4 * HOUR))], [{ id: 5, value: '203.0.113.7', until: at(4 * HOUR + 90_000) }], NOW)).toEqual({ remove: [], add: [] });
  });

  it('hebt auf, was der Hauptknoten nicht mehr nennt', () => {
    expect(planBans([], [{ id: 5, value: '203.0.113.7', until: at(HOUR) }, { id: 6, value: '203.0.113.8', until: at(HOUR) }], NOW)).toEqual({ remove: [5, 6], add: [] });
  });

  it('setzt neu, was dort verlängert oder verkürzt wurde', () => {
    const plan = planBans([ban('203.0.113.7', at(24 * HOUR))], [{ id: 5, value: '203.0.113.7', until: at(HOUR) }], NOW);
    expect(plan.remove).toEqual([5]);
    expect(plan.add).toEqual([{ value: '203.0.113.7', scope: 'ip', reason: 'Gesperrt in HAPM', seconds: 24 * 3600 }]);
  });

  it('nimmt je Adresse die längste und nichts, was gleich abläuft', () => {
    const plan = planBans([ban('203.0.113.7', at(HOUR)), ban('203.0.113.7', at(8 * HOUR)), ban('203.0.113.8', at(30_000)), ban('203.0.113.9', 'kein Datum')], [], NOW);
    expect(plan.add).toEqual([{ value: '203.0.113.7', scope: 'ip', reason: 'Gesperrt in HAPM', seconds: 8 * 3600 }]);
  });
});

describe('Freigaben auf dem Folgeknoten', () => {
  it('setzt, was fehlt, und entfernt, was der Hauptknoten nicht nennt', () => {
    const plan = planAllowlist(
      [{ value: '198.51.100.0/24', description: 'Büro', expiresAt: null }, { value: '192.0.2.4', description: 'Test', expiresAt: at(24 * HOUR) }],
      [{ value: '192.0.2.99', description: 'alt', expiresAt: null }],
      NOW
    );
    expect(plan.remove).toEqual(['192.0.2.99']);
    expect(plan.add).toEqual([
      { value: '198.51.100.0/24', description: 'Büro', seconds: null },
      { value: '192.0.2.4', description: 'Test', seconds: 24 * 3600 },
    ]);
  });

  it('lässt stehen, was schon so freigegeben ist', () => {
    const wanted = [{ value: '198.51.100.0/24', description: 'Büro', expiresAt: null }, { value: '192.0.2.4', description: 'Test', expiresAt: at(24 * HOUR) }];
    const local = [{ value: '198.51.100.0/24', description: 'Büro', expiresAt: null }, { value: '192.0.2.4', description: 'Test', expiresAt: at(24 * HOUR - 60_000) }];
    expect(planAllowlist(wanted, local, NOW)).toEqual({ remove: [], add: [] });
  });

  it('setzt neu, was anders beschrieben ist oder anders endet', () => {
    const plan = planAllowlist(
      [{ value: '198.51.100.0/24', description: 'Büro Kiel', expiresAt: null }, { value: '192.0.2.4', description: 'Test', expiresAt: null }],
      [{ value: '198.51.100.0/24', description: 'Büro', expiresAt: null }, { value: '192.0.2.4', description: 'Test', expiresAt: at(HOUR) }],
      NOW
    );
    expect(plan.remove).toEqual(['198.51.100.0/24', '192.0.2.4']);
    expect(plan.add.map((entry) => entry.value)).toEqual(['198.51.100.0/24', '192.0.2.4']);
  });
});

describe('der Anstoß nach einer Handlung', () => {
  it('kommt nach allem, was der Abgleich überträgt', () => {
    for (const action of [
      'user_created',
      'user_deleted',
      'password_changed',
      'password_reset_completed',
      'passkey_added',
      '2fa_setup',
      '2fa_disabled',
      '2fa_recovery_codes_created',
      '2fa_recovery_code_used',
      'settings_updated',
      'address_move_finished',
      'dns_zone_created',
      'dns_zone_deleted',
      'service_token_created',
      'service_token_revoked',
      'crowdsec_decision_added',
      'crowdsec_allowlist_removed',
      'crowdsec_rules_updated',
    ]) {
      expect(changesSyncedData(action), action).toBe(true);
    }
  });

  it('kommt nicht nach dem, was jeder Knoten für sich tut oder was schon die Dateien anstoßen', () => {
    for (const action of ['login', 'login_failed', 'logout', '2fa_verified', 'sync_applied', 'sync_completed', 'backup_completed', 'update_started', 'haproxy_service_created', 'audit_exported', 'gibt_es_nicht']) {
      expect(changesSyncedData(action), action).toBe(false);
    }
  });

  it('kennt jede Handlung des Protokolls', () => {
    // Eine neue Handlung ohne Bereich fiele hier still heraus.
    for (const action of Object.keys(AUDIT_ACTIONS)) expect(typeof changesSyncedData(action)).toBe('boolean');
  });
});
