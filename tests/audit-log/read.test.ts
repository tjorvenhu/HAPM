import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { SETTLE_MS, actorTypeOf, filterOf, readAuditQuery, settledId, toEntry } from '@/lib/audit-log/read';
import { idAtTime } from '@/lib/db/audit-query';

/**
 * Die Parameter einer Abfrage des Protokolls. Dieselbe Prüfung gilt für die
 * Seite, die interne API und das MCP-Werkzeug.
 */

const ID = '0193a0b1c2d3700080000000000000aa';

describe('readAuditQuery', () => {
  it('liest ohne Angaben das Neueste zuerst, fünfzig Einträge', () => {
    expect(readAuditQuery({})).toMatchObject({ order: 'desc', limit: 50 });
  });

  it('liest mit after aufsteigend, auch ohne order', () => {
    expect(readAuditQuery({ after: ID })).toMatchObject({ order: 'asc', after: ID });
    expect(readAuditQuery({ order: 'asc' }).order).toBe('asc');
  });

  it('bringt einen Zeitpunkt in ISO-Form', () => {
    expect(readAuditQuery({ from: '2026-11-26T09:00:00+01:00' }).from).toBe('2026-11-26T08:00:00.000Z');
  });

  it('übergeht leere Angaben, wie sie eine Adresszeile mitbringt', () => {
    expect(readAuditQuery({ from: '', actor: '', area: '', q: '  ', limit: '' })).toMatchObject({
      from: undefined,
      actor: undefined,
      area: undefined,
      q: undefined,
      limit: 50,
    });
  });

  it.each([
    [{ from: 'gestern' }],
    [{ actor: 'admin' }],
    [{ area: 'postgres' }],
    [{ limit: '0' }],
    [{ limit: '1001' }],
    [{ limit: 'viele' }],
    [{ before: 'abc' }],
    [{ after: "1' or '1'='1" }],
    [{ before: ID, after: ID }],
    [{ order: 'zufall' }],
    [{ after: ID, order: 'desc' }],
    [{ before: ID, order: 'asc' }],
    [{ q: 'x'.repeat(201) }],
  ])('lehnt %j mit einer Meldung ab', (input) => {
    expect(() => readAuditQuery(input)).toThrow(ApiError);
  });

  it('macht aus dem Bereich die Liste seiner Handlungen', () => {
    const filter = filterOf(readAuditQuery({ area: 'tokens', q: 'deploy' }));
    expect(filter.actions).toContain('service_token_created');
    expect(filter.actions).not.toContain('login');
    expect(filter.search).toBe('deploy');
    expect(filterOf(readAuditQuery({})).actions).toBeUndefined();
  });
});

describe('Einträge', () => {
  it('erkennt am Akteur, wer gehandelt hat', () => {
    expect(actorTypeOf('system')).toBe('system');
    expect(actorTypeOf('service:abc')).toBe('service');
    expect(actorTypeOf('u123')).toBe('user');
    // Eine gescheiterte Anmeldung kennt kein Konto.
    expect(actorTypeOf('')).toBe('user');
  });

  it('formt eine Zeile der Datenbank um und leitet Bereich und Ergebnis ab', () => {
    const entry = toEntry({
      $id: ID,
      $createdAt: '2026-11-26T08:00:00.000Z',
      $updatedAt: '2026-11-26T08:00:00.000Z',
      userId: 'service:t1',
      userEmail: 'deploy',
      action: 'haproxy_service_failed',
      resource: 'haproxy_service',
      resourceId: 'shop',
      details: 'haproxy -c lehnt ab',
      ip: '10.0.0.9',
      timestamp: '2026-11-26T08:00:00.100Z',
    });
    expect(entry).toEqual({
      id: ID,
      timestamp: '2026-11-26T08:00:00.100Z',
      action: 'haproxy_service_failed',
      area: 'proxy',
      actorType: 'service',
      actor: 'deploy',
      actorId: 'service:t1',
      resource: 'haproxy_service',
      resourceId: 'shop',
      details: 'haproxy -c lehnt ab',
      ip: '10.0.0.9',
      outcome: 'failure',
    });
  });
});

describe('der feste Rand', () => {
  it('liegt um SETTLE_MS vor jetzt', () => {
    const now = Date.UTC(2026, 10, 26, 8, 0, 0);
    expect(settledId(now)).toBe(idAtTime(now - SETTLE_MS));
    expect(SETTLE_MS).toBeGreaterThanOrEqual(1000);
  });
});
