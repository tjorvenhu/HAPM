/**
 * Der Treiber hinter `lib/db`: Postgres, der dritte Container im Stack.
 *
 * Die Anmeldung läuft über Better-Auth (`lib/auth`), und das setzt eine
 * SQL-Datenbank voraus. Damit es bei einer Datenbank bleibt, liegen auch die
 * Daten von HAPM dort. Die Fassade spricht in Dokumenten, und so liegen sie
 * auch in den Tabellen: Dokumente als `jsonb`, keine Spalte je Feld und kein
 * Schema-Abgleich. Wie daraus SQL wird, steht in `sql.ts`.
 *
 * Die Verbindung geht über den Unix-Socket, den sich beide Container über ein
 * Volume teilen. Postgres lauscht auf keinem Port und kennt kein Passwort: wer
 * den Socket erreicht, ist HAPM. `DATABASE_URL` gewinnt, wenn gesetzt, und ist
 * für Tests und die Entwicklung ohne Compose gedacht.
 */

import postgres from 'postgres';
import { COLLECTIONS } from '../types';
import { NotFoundError, type DbDriver, type WithMeta } from './driver';
import { uniqueId, type Predicate } from './query';
import {
  createIndexSql,
  createTableSql,
  deleteSql,
  deleteWhereSql,
  getSql,
  insertSql,
  isMetaField,
  selectSql,
  tableName,
  updateSql,
  type Statement,
} from './sql';

export type Sql = ReturnType<typeof postgres>;

/**
 * Wenige Verbindungen, und sie schließen sich im Leerlauf bald wieder.
 *
 * Jede offene Verbindung ist ein Prozess im Postgres-Container. HAPM hat eine
 * Handvoll Benutzer und schreibt eine Zeile Statistik je Minute und Abschnitt:
 * dafür reichen fünf, und meistens ist keine offen. Postgres selbst lässt
 * zwanzig zu (Compose), damit `hapm-admin` und eine Sicherung daneben Platz haben.
 */
const POOL = {
  max: 5,
  idle_timeout: 20,
  connect_timeout: 10,
  onnotice: () => {},
  /**
   * Fristen, weil postgres.js keine eigene kennt: eine blockierte Abfrage käme
   * sonst nie zurück, und der Scheduler stünde mit ihr.
   */
  connection: {
    statement_timeout: 30_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 30_000,
  },
};

export function databaseTarget(): { url: string } | { host: string; database: string; username: string } {
  const url = process.env.DATABASE_URL;
  if (url) return { url };
  return {
    host: process.env.HAPM_DATABASE_SOCKET || '/var/run/postgresql',
    database: process.env.HAPM_DATABASE_NAME || 'hapm',
    username: process.env.HAPM_DATABASE_USER || 'hapm',
  };
}

// Next hält den Modulzustand in der Entwicklung nicht über ein Neuladen hinweg.
// Ohne den globalen Platz entstünde bei jeder Änderung ein neuer Pool.
const globalForDb = globalThis as unknown as {
  __hapmSql?: Sql;
  __hapmTables?: Map<string, Promise<void>>;
};

export function sql(): Sql {
  if (!globalForDb.__hapmSql) {
    const target = databaseTarget();
    globalForDb.__hapmSql = 'url' in target ? postgres(target.url, POOL) : postgres({ ...target, ...POOL });
  }
  return globalForDb.__hapmSql;
}

function tables(): Map<string, Promise<void>> {
  globalForDb.__hapmTables ??= new Map();
  return globalForDb.__hapmTables;
}

/** Für Tests und Skripte: sonst hält der offene Pool den Prozess am Leben. */
export async function closeDatabase(): Promise<void> {
  const client = globalForDb.__hapmSql;
  globalForDb.__hapmSql = undefined;
  globalForDb.__hapmTables = undefined;
  if (client) await client.end({ timeout: 5 });
}

/**
 * Die Tabelle einer Collection anlegen, falls sie fehlt.
 *
 * Beim Start geschieht das für alle (`ensureCollections`). Der Weg über den
 * ersten Zugriff bleibt für Tests und Skripte, die ohne den Start auskommen.
 * Ein Versprechen je Collection: zwei gleichzeitige `create table if not exists`
 * können in Postgres aneinander scheitern.
 */
function ensureTable(collectionId: string): Promise<void> {
  tableName(collectionId);
  const known = tables();
  let pending = known.get(collectionId);
  if (!pending) {
    pending = (async () => {
      const db = sql();
      await db.unsafe(createTableSql(collectionId));
      for (const statement of createIndexSql(collectionId)) await db.unsafe(statement);
    })();
    known.set(collectionId, pending);
    pending.catch(() => known.delete(collectionId));
  }
  return pending;
}

export async function ensureCollections(): Promise<void> {
  for (const collectionId of Object.values(COLLECTIONS)) await ensureTable(collectionId);
}

interface Row {
  id: string;
  created_at: string;
  updated_at: string;
  data: unknown;
}

function toDoc<T>(row: Row): WithMeta<T> {
  // Über `unsafe` kommt `jsonb` je nach Weg als Objekt oder als Text an.
  const data = typeof row.data === 'string' ? (JSON.parse(row.data) as T) : (row.data as T);
  return { ...data, $id: row.id, $createdAt: row.created_at, $updatedAt: row.updated_at };
}

/** Die Meta-Felder stehen in eigenen Spalten und nicht noch einmal im Dokument. */
function serialise<T>(data: Partial<T>): string {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (isMetaField(key) || value === undefined) continue;
    out[key] = value;
  }
  return JSON.stringify(out);
}

async function run(collectionId: string, statement: Statement) {
  await ensureTable(collectionId);
  return sql().unsafe(statement.text, statement.params);
}

export const postgresDriver: DbDriver = {
  name: 'postgres',

  async list<T>(collectionId: string, predicates: Predicate[]) {
    const rows = (await run(collectionId, selectSql(collectionId, predicates))) as unknown as Row[];
    return rows.map((row) => toDoc<T>(row));
  },

  async get<T>(collectionId: string, documentId: string) {
    const rows = (await run(collectionId, getSql(collectionId, documentId))) as unknown as Row[];
    if (rows.length === 0) throw new NotFoundError(collectionId, documentId);
    return toDoc<T>(rows[0]);
  },

  async create<T>(collectionId: string, data: Partial<T>, id?: string) {
    const statement = insertSql(collectionId, id ?? uniqueId(), new Date().toISOString(), serialise(data));
    const rows = (await run(collectionId, statement)) as unknown as Row[];
    return toDoc<T>(rows[0]);
  },

  async update<T>(collectionId: string, documentId: string, data: Partial<T>) {
    const statement = updateSql(collectionId, documentId, new Date().toISOString(), serialise(data));
    const rows = (await run(collectionId, statement)) as unknown as Row[];
    if (rows.length === 0) throw new NotFoundError(collectionId, documentId);
    return toDoc<T>(rows[0]);
  },

  async remove(collectionId: string, documentId: string) {
    await run(collectionId, deleteSql(collectionId, documentId));
  },

  async removeWhere(collectionId: string, predicates: Predicate[]) {
    const result = await run(collectionId, deleteWhereSql(collectionId, predicates));
    return result.count;
  },
};
