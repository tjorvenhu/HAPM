import { describe, expect, it } from 'vitest';
import { Query } from '@/lib/db/query';
import {
  createIndexSql,
  createTableSql,
  deleteWhereSql,
  fieldName,
  insertSql,
  selectSql,
  tableName,
  updateSql,
} from '@/lib/db/sql';

/**
 * Wie aus einer Abfrage SQL wird, ohne Datenbank. Dass das SQL auch das Richtige
 * findet, prüft `driver.test.ts` gegen ein echtes Postgres.
 */

const RUNS = 'haproxy_runs';

describe('Namen', () => {
  it('lässt nur bekannte Collections zu', () => {
    expect(tableName(RUNS)).toBe('"haproxy_runs"');
    expect(() => tableName('gibt_es_nicht')).toThrow(/Unbekannte Collection/);
    expect(() => tableName('haproxy_runs"; drop table x; --')).toThrow(/Unbekannte Collection/);
  });

  it('lässt nur schlichte Feldnamen zu', () => {
    expect(fieldName('startedAt')).toBe('startedAt');
    for (const bad of ['', "a'b", 'a"b', 'a b', 'a.b', '1a', 'a;b', 'a-b', '$id']) {
      expect(() => fieldName(bad), bad).toThrow(/Feldname/);
    }
  });
});

describe('Tabellen und Indizes', () => {
  it('legt vier Spalten an, das Dokument als jsonb', () => {
    expect(createTableSql(RUNS)).toBe(
      'create table if not exists "haproxy_runs" (id text collate "C" primary key, ' +
        'created_at timestamptz not null, updated_at timestamptz not null, data jsonb not null)'
    );
  });

  it('indiziert denselben Ausdruck, den die Abfrage benutzt', () => {
    const [index] = createIndexSql(RUNS);
    expect(index).toBe(
      'create index if not exists "idx_haproxy_runs_status" on "haproxy_runs" (((data->>\'status\') collate "C"))'
    );
    const { text } = selectSql(RUNS, [Query.equal('status', 'running')]);
    expect(text).toContain('((data->>\'status\') collate "C") = $1::text');
  });

  it('kennt Collections ohne Indizes', () => {
    expect(createIndexSql('settings')).toEqual([]);
  });
});

describe('Abfragen', () => {
  it('setzt ohne Angabe 25 Zeilen und kein Überspringen', () => {
    const { text, params } = selectSql(RUNS, []);
    expect(text).toMatch(/ from "haproxy_runs" limit \$1::int offset \$2::int$/);
    expect(params).toEqual(['25', '0']);
  });

  it('nimmt das letzte Limit und den letzten Offset', () => {
    const { params } = selectSql(RUNS, [Query.limit(5), Query.offset(2), Query.limit(1000), Query.offset(40)]);
    expect(params).toEqual(['1000', '40']);
  });

  it('reicht Werte nie im Text durch', () => {
    const evil = "x'; drop table haproxy_runs; --";
    const { text, params } = selectSql(RUNS, [Query.equal('status', evil)]);
    expect(text).not.toContain('drop table');
    expect(params[0]).toBe(evil);
  });

  it('vergleicht Text als Text, Zahlen als Zahlen und Wahrheitswerte als JSON', () => {
    const { text, params } = selectSql(RUNS, [
      Query.lessThan('startedAt', '2026-01-01T00:00:00.000Z'),
      Query.greaterThanEqual('duration', 38),
      Query.equal('acknowledged', true),
    ]);
    expect(text).toContain('((data->>\'startedAt\') collate "C") < $1::text');
    expect(text).toContain(
      "(case when jsonb_typeof(data->'duration') = 'number' then (data->>'duration')::numeric end) >= $2::numeric"
    );
    expect(text).toContain("(data->'acknowledged') = $3::text::jsonb");
    expect(params.slice(0, 3)).toEqual(['2026-01-01T00:00:00.000Z', '38', 'true']);
  });

  it('behandelt null und ein fehlendes Feld gleich', () => {
    expect(selectSql(RUNS, [Query.isNull('acknowledged')]).text).toContain("(data->>'acknowledged') is null");
    expect(selectSql(RUNS, [Query.isNotNull('acknowledged')]).text).toContain(
      "(data->>'acknowledged') is not null"
    );
  });

  it('schließt bei notEqual fehlende Werte ein', () => {
    expect(selectSql(RUNS, [Query.notEqual('status', 'ok')]).text).toContain(
      '((data->>\'status\') collate "C") is distinct from $1::text'
    );
    expect(selectSql(RUNS, [Query.notEqual('acknowledged', true)]).text).toContain(
      "(data->'acknowledged') is distinct from $1::text::jsonb"
    );
  });

  it('macht aus einer Liste einen Vergleich je Wert und aus einer leeren Liste nichts', () => {
    const many = selectSql(RUNS, [Query.equal('serviceId', ['a', 'b'])]);
    expect(many.text).toContain(
      '(((data->>\'serviceId\') collate "C") = $1::text or ((data->>\'serviceId\') collate "C") = $2::text)'
    );
    expect(many.params.slice(0, 2)).toEqual(['a', 'b']);
    expect(selectSql(RUNS, [Query.equal('serviceId', [])]).text).toContain(' where false ');
    expect(() => selectSql(RUNS, [{ kind: 'where', op: 'lt', field: 'serviceId', value: ['a'] }])).toThrow(/Liste/);
  });

  it('spricht die Meta-Felder als Spalten an', () => {
    const { text, params } = selectSql(RUNS, [
      Query.greaterThan('$id', 'abc'),
      Query.lessThan('$createdAt', '2026-01-01T00:00:00.000Z'),
      Query.orderAsc('$id'),
    ]);
    expect(text).toContain('id > $1::text');
    expect(text).toContain('created_at < $2::timestamptz');
    expect(text).toContain(' order by id asc ');
    expect(params.slice(0, 2)).toEqual(['abc', '2026-01-01T00:00:00.000Z']);
    expect(() => selectSql(RUNS, [Query.equal('$id', 5)])).toThrow(/nur mit Text/);
  });

  it('sortiert erst als Zahl, dann als Text, fehlende Werte wie bisher', () => {
    const { text } = selectSql(RUNS, [Query.orderDesc('startedAt'), Query.orderAsc('duration')]);
    expect(text).toContain(
      "order by (case when jsonb_typeof(data->'startedAt') = 'number' then (data->>'startedAt')::numeric end) desc nulls last, " +
        '((data->>\'startedAt\') collate "C") desc nulls last, ' +
        "(case when jsonb_typeof(data->'duration') = 'number' then (data->>'duration')::numeric end) asc nulls first, " +
        '((data->>\'duration\') collate "C") asc nulls first'
    );
  });

  it('lehnt ab, was sich nicht vergleichen lässt', () => {
    expect(() => selectSql(RUNS, [{ kind: 'where', op: 'eq', field: 'status' }])).toThrow(/ohne Wert/);
    expect(() => selectSql(RUNS, [Query.lessThan('acknowledged', true)])).toThrow(/Wahrheitswert/);
    expect(() => selectSql(RUNS, [Query.equal('duration', Number.NaN)])).toThrow(/keine ist/);
    expect(() => selectSql(RUNS, [Query.limit(-1)])).toThrow(/limit/);
    expect(() => selectSql(RUNS, [Query.limit(1.5)])).toThrow(/limit/);
  });
});

describe('Schreiben', () => {
  it('legt an und mischt beim Ändern', () => {
    const insert = insertSql(RUNS, 'id1', '2026-01-01T00:00:00.000Z', '{"a":1}');
    expect(insert.text).toContain('values ($1::text, $2::timestamptz, $2::timestamptz, $3::text::jsonb)');
    expect(insert.params).toEqual(['id1', '2026-01-01T00:00:00.000Z', '{"a":1}']);

    const update = updateSql(RUNS, 'id1', '2026-01-02T00:00:00.000Z', '{"a":2}');
    expect(update.text).toContain('set data = data || $3::text::jsonb, updated_at = $2::timestamptz where id = $1::text');
  });

  it('löscht nach Bedingung, mit Limit über die Kennungen', () => {
    const all = deleteWhereSql(RUNS, [Query.lessThan('startedAt', 'x')]);
    expect(all.text).toBe('delete from "haproxy_runs" where ((data->>\'startedAt\') collate "C") < $1::text');

    const capped = deleteWhereSql(RUNS, [Query.lessThan('startedAt', 'x'), Query.limit(10)]);
    expect(capped.text).toBe(
      'delete from "haproxy_runs" where id in (select id from "haproxy_runs" ' +
        'where ((data->>\'startedAt\') collate "C") < $1::text limit $2::int)'
    );
    expect(capped.params).toEqual(['x', '10']);
  });

  it('löscht nie ohne Bedingung', () => {
    expect(() => deleteWhereSql(RUNS, [])).toThrow(/ohne Bedingung/);
    expect(() => deleteWhereSql(RUNS, [Query.limit(5), Query.orderAsc('startedAt')])).toThrow(/ohne Bedingung/);
  });
});
