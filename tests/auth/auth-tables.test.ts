import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { is, SQL } from 'drizzle-orm';
import { createAuthTables } from '@/lib/auth/core/schema';
import { AUTH_TABLE_STATEMENTS } from '@/lib/db/auth-tables';
import { TEST_DATABASE_URL, announceSkip, createTestSchema, dropTestSchema } from '../helpers/test-database';

/**
 * Das ausgeschriebene SQL gegen die Definitionen des Anmeldedienstes.
 *
 * `lib/db/auth-tables.ts` legt die Tabellen an, `lib/auth/core/schema.ts` sagt
 * Better-Auth, wie sie aussehen. Laufen beide auseinander (eine neue Fassung
 * des Kerns bringt eine Spalte mit), fällt das sonst erst bei der ersten
 * Anmeldung auf einer bestehenden Installation auf.
 *
 * Verglichen wird gegen das Drizzle-Schema selbst und nicht gegen eine zweite
 * Abschrift: aus jeder Tabelle entsteht hier das SQL, das dastehen müsste.
 * Schlägt der Test an, steht im Kopf von `auth-tables.ts`, was zu tun ist.
 */

const dialect = new PgDialect();

function defaultSql(value: unknown): string {
  if (is(value, SQL)) return dialect.sqlToQuery(value).sql;
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  throw new Error(`Vorgabewert, den dieser Test nicht kennt: ${String(value)}`);
}

function expectedStatements(table: PgTable): string[] {
  const config = getTableConfig(table);
  const references = new Map(
    config.foreignKeys.map((fk) => {
      const ref = fk.reference();
      if (ref.columns.length !== 1) throw new Error('Zusammengesetzte Fremdschlüssel kennt dieser Test nicht.');
      const target = `"${getTableConfig(ref.foreignTable).name}" ("${ref.foreignColumns[0].name}")`;
      return [ref.columns[0].name, ` references ${target}${fk.onDelete ? ` on delete ${fk.onDelete}` : ''}`];
    })
  );

  const columns = config.columns.map((column) => {
    let line = `"${column.name}" ${column.getSQLType()}`;
    if (column.primary) line += ' primary key';
    else if (column.notNull) line += ' not null';
    if (column.hasDefault) line += ` default ${defaultSql(column.default)}`;
    line += references.get(column.name) ?? '';
    return line;
  });
  const uniques = config.columns
    .filter((column) => column.isUnique)
    .map((column) => `constraint "${column.uniqueName}" unique ("${column.name}")`);

  const indexes = config.indexes.map((index) => {
    const names = index.config.columns.map((column) => `"${(column as { name: string }).name}"`).join(', ');
    return `create ${index.config.unique ? 'unique ' : ''}index if not exists "${index.config.name}" on "${config.name}" (${names})`;
  });

  return [`create table if not exists "${config.name}" (${[...columns, ...uniques].join(', ')})`, ...indexes];
}

const tables = Object.values(createAuthTables()) as PgTable[];

describe('die Tabellen der Anmeldung', () => {
  it('stehen in auth-tables.ts so, wie der Kern sie definiert', () => {
    expect(AUTH_TABLE_STATEMENTS).toEqual(tables.flatMap(expectedStatements));
  });

  it('liegen im Schema des Suchpfads, nicht in einem eigenen', () => {
    for (const table of tables) expect(getTableConfig(table).schema).toBeUndefined();
  });

  it('legen eine Tabelle vor denen an, die auf sie verweisen', () => {
    const created: string[] = [];
    for (const statement of AUTH_TABLE_STATEMENTS) {
      const name = /^create table if not exists "([^"]+)"/.exec(statement)?.[1];
      for (const [, target] of statement.matchAll(/references "([^"]+)"/g)) {
        expect(created, `${name ?? statement} verweist auf ${target}`).toContain(target);
      }
      if (name) created.push(name);
    }
  });
});

const SCHEMA = `hapm_test_authtables_${process.pid}`;
const suite = TEST_DATABASE_URL ? describe : describe.skip;
if (!TEST_DATABASE_URL) announceSkip('tests/auth/auth-tables');

suite('die Tabellen der Anmeldung in Postgres', () => {
  beforeAll(async () => {
    await createTestSchema(SCHEMA);
  });

  afterAll(async () => {
    const { closeDatabase } = await import('@/lib/db/postgres-driver');
    await closeDatabase();
    await dropTestSchema(SCHEMA);
  });

  it('entstehen, und ein zweiter Lauf ändert nichts', async () => {
    const { ensureAuthTables } = await import('@/lib/db/auth-tables');
    const { sql } = await import('@/lib/db/postgres-driver');
    await ensureAuthTables();
    await ensureAuthTables();

    const columns = await sql()<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns where table_schema = ${SCHEMA}
    `;
    const found = new Set(columns.map((row) => `${row.table_name}.${row.column_name}`));
    const wanted = tables.flatMap((table) => {
      const config = getTableConfig(table);
      return config.columns.map((column) => `${config.name}.${column.name}`);
    });
    expect([...found].sort()).toEqual(wanted.sort());
  });
});
