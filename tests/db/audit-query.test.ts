import { describe, expect, it } from 'vitest';
import { auditCountSql, auditSelectSql, auditTotalsSql, idAtTime, likePattern } from '@/lib/db/audit-query';
import { uniqueId } from '@/lib/db/query';

/**
 * Das SQL hinter der Seite „Protokoll", ohne Verbindung nachgerechnet.
 *
 * Zwei Dinge dürfen nie passieren: ein Wert steht im Text der Anweisung, und
 * ein Suchtext wirkt als Muster. Beides hält diese Datei fest. Gegen ein
 * echtes Postgres prüft `tests/audit-log/database.test.ts`.
 */

const ID = '0193a0b1c2d3700080000000000000aa';

describe('Abfrage des Protokolls', () => {
  it('liest ohne Filter das Neueste zuerst, mit der Grenze als Parameter', () => {
    const statement = auditSelectSql({}, 'desc', 50);
    expect(statement.text).toContain('from "audit_logs" order by id desc limit $1::int');
    expect(statement.text).not.toContain('where');
    expect(statement.params).toEqual(['50']);
  });

  it('setzt jeden Wert als Parameter und keinen in den Text', () => {
    const statement = auditSelectSql(
      {
        from: '2026-11-01T00:00:00.000Z',
        to: '2026-11-30T23:59:59.999Z',
        actions: ['login', "x' or '1'='1"],
        search: "Robert'); drop table audit_logs;--",
        after: ID,
      },
      'asc',
      100
    );
    expect(statement.text).not.toContain('drop table');
    expect(statement.text).not.toContain("or '1'='1");
    expect(statement.text).not.toContain('2026-11-01');
    expect(statement.params).toEqual([
      '2026-11-01T00:00:00.000Z',
      '2026-11-30T23:59:59.999Z',
      'login',
      "x' or '1'='1",
      "%Robert'); drop table audit\\_logs;--%",
      ID,
      '100',
    ]);
    expect(statement.text).toContain('order by id asc');
  });

  it('vergleicht die Zeit über den Ausdruck des Index', () => {
    const statement = auditSelectSql({ from: '2026-11-01T00:00:00.000Z' }, 'desc', 10);
    expect(statement.text).toContain(`((data->>'timestamp') collate "C") >= $1::text`);
  });

  it('sucht in sechs Feldern mit demselben Muster', () => {
    const statement = auditSelectSql({ search: 'shop' }, 'desc', 10);
    expect(statement.text.match(/ilike \$1::text/g)).toHaveLength(6);
    expect(statement.params[0]).toBe('%shop%');
  });

  it('nimmt einem Suchtext die Bedeutung als Muster', () => {
    expect(likePattern('100%')).toBe('%100\\%%');
    expect(likePattern('a_b')).toBe('%a\\_b%');
    expect(likePattern('c:\\temp')).toBe('%c:\\\\temp%');
  });

  it('unterscheidet Konto, API-Key und System am Anfang der Kennung', () => {
    expect(auditSelectSql({ actor: 'system' }, 'desc', 10).text).toContain(`coalesce(data->>'userId', '') = 'system'`);
    expect(auditSelectSql({ actor: 'service' }, 'desc', 10).text).toContain(`left(coalesce(data->>'userId', ''), 8) = 'service:'`);
    const user = auditSelectSql({ actor: 'user' }, 'desc', 10).text;
    expect(user).toContain(`<> 'system'`);
    expect(user).toContain(`<> 'service:'`);
  });

  it('trifft mit einer leeren Liste von Handlungen nichts statt alles', () => {
    expect(auditSelectSql({ actions: [] }, 'desc', 10).text).toContain('where false');
  });

  it('lehnt eine Marke ab, die keine Kennung ist', () => {
    expect(() => auditSelectSql({ after: "x' or 1=1" }, 'asc', 10)).toThrow();
    expect(() => auditSelectSql({ before: '123' }, 'desc', 10)).toThrow();
    expect(() => auditSelectSql({ upTo: ID.toUpperCase() }, 'asc', 10)).toThrow();
  });

  it('lehnt eine Grenze außerhalb von 1 bis 5000 ab', () => {
    expect(() => auditSelectSql({}, 'desc', 0)).toThrow();
    expect(() => auditSelectSql({}, 'desc', 5001)).toThrow();
    expect(() => auditSelectSql({}, 'desc', 1.5)).toThrow();
  });

  it('zählt höchstens bis zur Obergrenze', () => {
    const statement = auditCountSql({ after: ID }, 5000);
    expect(statement.text).toBe(
      'select count(*)::int as count from (select 1 from "audit_logs" where id > $1::text limit $2::int) as capped'
    );
    expect(statement.params).toEqual([ID, '5000']);
  });

  it('fragt Anzahl und ältesten Eintrag ohne Parameter', () => {
    expect(auditTotalsSql().params).toEqual([]);
    expect(auditTotalsSql().text).toContain('min(');
  });
});

describe('idAtTime', () => {
  it('ist die kleinste Kennung einer Millisekunde', () => {
    const now = Date.now();
    const id = uniqueId();
    expect(idAtTime(now - 5)).toMatch(/^[0-9a-f]{32}$/);
    expect(idAtTime(now - 5) < id).toBe(true);
    expect(idAtTime(now + 60_000) > id).toBe(true);
  });

  it('ordnet sich wie die Zeit', () => {
    expect(idAtTime(1000) < idAtTime(1001)).toBe(true);
    expect(idAtTime(Date.UTC(2026, 0, 1)) < idAtTime(Date.UTC(2026, 0, 2))).toBe(true);
    expect(idAtTime(-5)).toBe('0'.repeat(32));
  });
});
