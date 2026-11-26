/**
 * Aus Abfragen wird SQL. Ohne Verbindung, damit sich jede Zeile prüfen lässt,
 * ohne dass ein Postgres läuft (`tests/db/sql.test.ts`).
 *
 * Jede Collection ist eine Tabelle mit vier Spalten: Kennung, zwei Zeitstempel
 * und das Dokument als `jsonb`. Felder werden im Dokument angesprochen. Ein
 * neues Feld braucht deshalb keine Migration, und ein gestrichenes blockiert
 * nichts. Wonach oft gesucht wird, steht in `INDEXES`.
 *
 * Zwei Regeln halten das sicher: Namen (Collection, Feld) werden geprüft und
 * stehen danach im Text, Werte stehen nie im Text, sondern immer als Parameter.
 *
 * ── Welcher Ausdruck für welches Feld ──
 *
 * Ein Feld im Dokument hat keinen Typ, den die Datenbank kennt. Den Vergleich
 * bestimmt deshalb der Wert, mit dem verglichen wird:
 *
 *  - Text: `data->>'feld'` mit der Sortierung "C". Zeitstempel stehen als
 *    ISO-Text im Dokument und ordnen sich so richtig, unabhängig davon, mit
 *    welcher Sprache die Datenbank angelegt wurde.
 *  - Zahl: der Wert als `numeric`, aber nur, wenn im Dokument wirklich eine
 *    Zahl steht. Ein nackter Cast würfe bei der ersten Zeile mit Text im Feld.
 *  - Wahrheitswert: der JSON-Wert selbst.
 *
 * `->>` liefert für ein fehlendes Feld und für JSON-`null` dasselbe: NULL.
 * Darauf stehen `isNull`, `isNotNull` und `notEqual` (das fehlende Werte
 * einschließt: „nicht gleich x" trifft auch ein Dokument ohne das Feld).
 */

import { COLLECTIONS } from '../types';
import { DEFAULT_LIMIT } from './driver';
import { partition, type Predicate, type QueryValue } from './query';

export interface Statement {
  text: string;
  params: string[];
}

/** Felder, über die gefiltert oder sortiert wird, je Collection. Alle sind Text. */
export const INDEXES: Record<string, string[]> = {
  [COLLECTIONS.TWO_FACTOR]: ['userId'],
  [COLLECTIONS.AUDIT_LOGS]: ['timestamp'],
  [COLLECTIONS.HAPROXY_RUNS]: ['status', 'startedAt', 'serviceId'],
  [COLLECTIONS.HAPROXY_METRICS]: ['collectedAt', 'scope'],
  [COLLECTIONS.SERVICE_TOKENS]: ['tokenHash'],
  [COLLECTIONS.UPDATE_RUNS]: ['startedAt', 'status'],
  [COLLECTIONS.SYNC_RUNS]: ['startedAt', 'status'],
};

const META_COLUMNS: Record<string, { column: string; cast: string }> = {
  $id: { column: 'id', cast: 'text' },
  $createdAt: { column: 'created_at', cast: 'timestamptz' },
  $updatedAt: { column: 'updated_at', cast: 'timestamptz' },
};

/**
 * Die Spalten einer Zeile, so wie der Treiber sie liest.
 *
 * Die Zeitstempel kommen als fertiger ISO-Text aus der Datenbank. Der Treiber
 * teilt sich die Verbindung mit Drizzle (für die Anmeldung), und Drizzle stellt
 * an ihr um, wie `timestamptz` gelesen wird. Was die Abfrage selbst formt,
 * hängt daran nicht.
 */
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
export const ROW_COLUMNS =
  `id, to_char(created_at at time zone 'UTC', ${ISO}) as created_at, ` +
  `to_char(updated_at at time zone 'UTC', ${ISO}) as updated_at, data`;

export function isMetaField(name: string): boolean {
  return name in META_COLUMNS;
}

export function fieldName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Unzulässiger Feldname: ${JSON.stringify(name)}`);
  }
  return name;
}

const KNOWN = () => new Set<string>(Object.values(COLLECTIONS));

/** Der Tabellenname in Anführungszeichen. Nur Collections aus `COLLECTIONS`. */
export function tableName(collectionId: string): string {
  if (!KNOWN().has(collectionId) || !/^[a-z_][a-z0-9_]*$/.test(collectionId)) {
    throw new Error(`Unbekannte Collection: ${collectionId}`);
  }
  return `"${collectionId}"`;
}

/** Ein Feld als Text. Muss mit dem Ausdruck der Indizes übereinstimmen. */
export function textExpression(field: string): string {
  return `((data->>'${fieldName(field)}') collate "C")`;
}

function numberExpression(field: string): string {
  const name = fieldName(field);
  return `(case when jsonb_typeof(data->'${name}') = 'number' then (data->>'${name}')::numeric end)`;
}

function jsonExpression(field: string): string {
  return `(data->'${fieldName(field)}')`;
}

export function createTableSql(collectionId: string): string {
  // `collate "C"`: die Kennungen sind UUIDv7 in Hex, `listAll` läuft über sie.
  // Mit der Sortierung der Bytes ist die Reihenfolge überall dieselbe.
  return (
    `create table if not exists ${tableName(collectionId)} (` +
    'id text collate "C" primary key, ' +
    'created_at timestamptz not null, ' +
    'updated_at timestamptz not null, ' +
    'data jsonb not null)'
  );
}

export function createIndexSql(collectionId: string): string[] {
  return (INDEXES[collectionId] ?? []).map(
    (field) =>
      `create index if not exists "idx_${collectionId}_${fieldName(field)}" ` +
      `on ${tableName(collectionId)} (${textExpression(field)})`
  );
}

/**
 * Ein JSON-Wert reist als Text und wird erst in der Datenbank zu `jsonb`.
 *
 * Sähe postgres.js einen Parameter vom Typ `jsonb`, liefe er durch dessen
 * JSON-Umwandlung, und aus dem fertigen Text würde ein JSON-String im Dokument.
 * Drizzle schaltet diese Umwandlung an der gemeinsamen Verbindung außerdem ab.
 * Über `text` hängt das Ergebnis an keinem von beiden.
 */
const JSONB = 'text::jsonb';

const OPERATORS = { eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' } as const;

class Params {
  readonly values: string[] = [];

  add(value: string, cast: string): string {
    this.values.push(value);
    return `$${this.values.length}::${cast}`;
  }
}

/** Linke Seite und Parameter für einen Vergleich mit genau diesem Wert. */
function operand(field: string, value: QueryValue, params: Params): { left: string; right: string } {
  const meta = META_COLUMNS[field];
  if (meta) {
    if (typeof value !== 'string') {
      throw new Error(`${field} lässt sich nur mit Text vergleichen.`);
    }
    return { left: meta.column, right: params.add(value, meta.cast) };
  }
  if (typeof value === 'string') {
    return { left: textExpression(field), right: params.add(value, 'text') };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Bedingung auf ${field} mit einer Zahl, die keine ist.`);
    return { left: numberExpression(field), right: params.add(String(value), 'numeric') };
  }
  if (typeof value === 'boolean') {
    return { left: jsonExpression(field), right: params.add(value ? 'true' : 'false', JSONB) };
  }
  throw new Error(`Bedingung auf ${field} mit einem Wert, der weder Text, Zahl noch Wahrheitswert ist.`);
}

function nullTest(field: string): string {
  const meta = META_COLUMNS[field];
  return meta ? meta.column : `(data->>'${fieldName(field)}')`;
}

function condition(w: Extract<Predicate, { kind: 'where' }>, params: Params): string {
  if (w.op === 'isNull') return `${nullTest(w.field)} is null`;
  if (w.op === 'isNotNull') return `${nullTest(w.field)} is not null`;

  if (Array.isArray(w.value)) {
    if (w.op !== 'eq') throw new Error(`Eine Liste geht nur mit equal, nicht mit ${w.op}.`);
    if (w.value.length === 0) return 'false';
    // Je Wert ein eigener Vergleich: eine Liste darf Text und Zahlen mischen.
    return `(${w.value
      .map((value) => {
        const { left, right } = operand(w.field, value, params);
        return `${left} = ${right}`;
      })
      .join(' or ')})`;
  }

  if (w.value === undefined) throw new Error(`Bedingung auf ${w.field} ohne Wert.`);

  const { left, right } = operand(w.field, w.value, params);
  // „ungleich" schließt fehlende Werte ein. Ein nacktes `<>` ließe jede Zeile
  // ohne das Feld stillschweigend fallen.
  if (w.op === 'ne') return `${left} is distinct from ${right}`;
  if (typeof w.value === 'boolean' && w.op !== 'eq') {
    throw new Error(`Ein Wahrheitswert lässt sich nur mit equal und notEqual vergleichen, nicht mit ${w.op}.`);
  }
  return `${left} ${OPERATORS[w.op]} ${right}`;
}

export function whereSql(predicates: Predicate[], params: Params): string {
  const { wheres } = partition(predicates);
  if (wheres.length === 0) return '';
  return ` where ${wheres.map((w) => condition(w, params)).join(' and ')}`;
}

/**
 * Die Sortierung nach einem Feld.
 *
 * Erst als Zahl, dann als Text: so ordnen sich Zahlen als Zahlen (9 vor 10)
 * und alles andere als Text. Für ein Textfeld ist der erste Ausdruck in jeder
 * Zeile NULL und ändert nichts. Fehlende Werte stehen aufsteigend vorn und
 * absteigend hinten, wie bisher.
 */
function orderTerms(order: Extract<Predicate, { kind: 'order' }>): string[] {
  const dir = order.dir === 'asc' ? 'asc nulls first' : 'desc nulls last';
  const meta = META_COLUMNS[order.field];
  if (meta) return [`${meta.column} ${order.dir === 'asc' ? 'asc' : 'desc'}`];
  return [`${numberExpression(order.field)} ${dir}`, `${textExpression(order.field)} ${dir}`];
}

export function selectSql(collectionId: string, predicates: Predicate[]): Statement {
  const params = new Params();
  const { orders, limit, offset } = partition(predicates);
  const where = whereSql(predicates, params);
  const order = orders.length ? ` order by ${orders.flatMap(orderTerms).join(', ')}` : '';
  const text =
    `select ${ROW_COLUMNS} from ${tableName(collectionId)}${where}${order}` +
    ` limit ${params.add(String(wholeNumber(limit ?? DEFAULT_LIMIT, 'limit')), 'int')}` +
    ` offset ${params.add(String(wholeNumber(offset ?? 0, 'offset')), 'int')}`;
  return { text, params: params.values };
}

export function getSql(collectionId: string, documentId: string): Statement {
  return {
    text: `select ${ROW_COLUMNS} from ${tableName(collectionId)} where id = $1::text`,
    params: [documentId],
  };
}

export function insertSql(collectionId: string, documentId: string, now: string, data: string): Statement {
  return {
    text:
      `insert into ${tableName(collectionId)} (id, created_at, updated_at, data) ` +
      `values ($1::text, $2::timestamptz, $2::timestamptz, $3::${JSONB}) returning ${ROW_COLUMNS}`,
    params: [documentId, now, data],
  };
}

/** `||` mischt auf der obersten Ebene: was im neuen Dokument nicht steht, bleibt. */
export function updateSql(collectionId: string, documentId: string, now: string, data: string): Statement {
  return {
    text:
      `update ${tableName(collectionId)} set data = data || $3::${JSONB}, updated_at = $2::timestamptz ` +
      `where id = $1::text returning ${ROW_COLUMNS}`,
    params: [documentId, now, data],
  };
}

export function deleteSql(collectionId: string, documentId: string): Statement {
  return { text: `delete from ${tableName(collectionId)} where id = $1::text`, params: [documentId] };
}

export function deleteWhereSql(collectionId: string, predicates: Predicate[]): Statement {
  const params = new Params();
  const { limit } = partition(predicates);
  const where = whereSql(predicates, params);
  // Ohne Bedingung leerte der Aufruf die ganze Tabelle. Das will hier niemand,
  // und ein Tippfehler, der es auslöst, ließe sich nicht zurücknehmen.
  if (!where) {
    throw new Error(`deleteWhere ohne Bedingung auf ${collectionId}: das würde die ganze Tabelle leeren.`);
  }
  const name = tableName(collectionId);
  const text =
    limit === null
      ? `delete from ${name}${where}`
      : `delete from ${name} where id in (select id from ${name}${where}` +
        ` limit ${params.add(String(wholeNumber(limit, 'limit')), 'int')})`;
  return { text, params: params.values };
}

function wholeNumber(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${what} muss eine ganze Zahl ab 0 sein.`);
  return value;
}
