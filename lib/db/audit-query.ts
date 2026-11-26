/**
 * Das Protokoll lesen: gefiltert, geblättert, gezählt.
 *
 * Eine eigene Datei mit eigenem SQL und nicht über `listDocuments`, weil die
 * Seite „Protokoll" drei Dinge braucht, die die Fassade mit Absicht nicht
 * kann (`driver.ts`, „Richer SQL belongs in the call sites"): eine Suche im
 * Text über mehrere Felder (ODER), ein Zählen ohne die Zeilen zu holen und
 * den Filter „wer" über den Anfang der Kennung.
 *
 * Wie in `sql.ts` entsteht jede Anweisung ohne Verbindung, damit
 * `tests/db/audit-query.test.ts` sie nachrechnen kann. Dieselben zwei Regeln:
 * Namen stehen fest im Text, Werte sind immer Parameter.
 *
 * ── Geblättert wird über die Kennung ──
 *
 * `$id` ist UUIDv7: eindeutig und nach der Zeit der Entstehung geordnet. Wer
 * die nächste Seite will, nennt die letzte Kennung der vorigen (`before` für
 * „älter", `after` für „neuer"). Ein `OFFSET` verschöbe sich mit jedem neuen
 * Eintrag, und im Protokoll kommt ständig einer dazu.
 *
 * ── Der Rand, an dem noch geschrieben wird ──
 *
 * Die Kennung entsteht vor dem Einfügen. Zwei Einträge derselben Millisekunde
 * können deshalb in umgekehrter Reihenfolge in der Tabelle ankommen. Wer nach
 * `after` weiterliest (die Weiterleitung, ein SIEM über die API), überspränge
 * den späteren. `upTo` schneidet den Rand ab: gelesen wird nur bis zu einer
 * Kennung, die alt genug ist, dass davor nichts mehr dazukommt
 * (`idAtTime`, `SETTLE_MS` in `lib/audit-log/read.ts`).
 */

import { COLLECTIONS, type AuditLog } from '../types';
import type { WithMeta } from './driver';
import { runStatement, toDoc, type Row } from './postgres-driver';
import { ROW_COLUMNS, tableName, textExpression, type Statement } from './sql';

/** Wer gehandelt hat, abgelesen an `userId` (`lib/audit.ts`: `system`, `service:<id>`, sonst ein Konto). */
export type AuditActorType = 'user' | 'service' | 'system';

export interface AuditFilter {
  /** ISO-Zeit, einschließlich. */
  from?: string;
  /** ISO-Zeit, einschließlich. */
  to?: string;
  actor?: AuditActorType;
  /** Nur diese Handlungen. Eine leere Liste trifft nichts. */
  actions?: readonly string[];
  /** Text, der in Wer, Handlung, Gegenstand, Einzelheiten oder Adresse vorkommt. */
  search?: string;
  /** Nur Einträge mit größerer Kennung (neuer). */
  after?: string;
  /** Nur Einträge mit kleinerer Kennung (älter). */
  before?: string;
  /** Höchstens bis zu dieser Kennung, einschließlich. */
  upTo?: string;
}

/** Die Felder, in denen die Suche liest. */
const SEARCH_FIELDS = ['userEmail', 'action', 'resource', 'resourceId', 'details', 'ip'] as const;

const SERVICE_PREFIX = 'service:';

class Params {
  readonly values: string[] = [];

  add(value: string, cast = 'text'): string {
    this.values.push(value);
    return `$${this.values.length}::${cast}`;
  }
}

/** `%`, `_` und `\` sind in einem LIKE-Muster Zeichen mit Bedeutung. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * Die kleinste Kennung, die zu einem Zeitpunkt entstehen kann: die 48 Bit der
 * Millisekunde, der Rest null. Alles, was vorher entstand, ist kleiner.
 */
export function idAtTime(ms: number): string {
  const whole = Math.max(0, Math.floor(ms));
  return whole.toString(16).padStart(12, '0').slice(-12) + '0'.repeat(20);
}

function assertId(value: string, what: string): string {
  if (!/^[0-9a-f]{32}$/.test(value)) throw new Error(`${what}: keine Kennung.`);
  return value;
}

function whereSql(filter: AuditFilter, params: Params): string {
  const parts: string[] = [];
  const userId = `coalesce(data->>'userId', '')`;

  if (filter.from) parts.push(`${textExpression('timestamp')} >= ${params.add(filter.from)}`);
  if (filter.to) parts.push(`${textExpression('timestamp')} <= ${params.add(filter.to)}`);

  if (filter.actor === 'system') parts.push(`${userId} = 'system'`);
  else if (filter.actor === 'service') parts.push(`left(${userId}, ${SERVICE_PREFIX.length}) = '${SERVICE_PREFIX}'`);
  else if (filter.actor === 'user') {
    parts.push(`(${userId} <> 'system' and left(${userId}, ${SERVICE_PREFIX.length}) <> '${SERVICE_PREFIX}')`);
  }

  if (filter.actions) {
    if (filter.actions.length === 0) parts.push('false');
    else parts.push(`(data->>'action') in (${filter.actions.map((action) => params.add(action)).join(', ')})`);
  }

  const search = filter.search?.trim();
  if (search) {
    const pattern = params.add(likePattern(search));
    parts.push(`(${SEARCH_FIELDS.map((field) => `(data->>'${field}') ilike ${pattern}`).join(' or ')})`);
  }

  if (filter.after) parts.push(`id > ${params.add(assertId(filter.after, 'after'))}`);
  if (filter.before) parts.push(`id < ${params.add(assertId(filter.before, 'before'))}`);
  if (filter.upTo) parts.push(`id <= ${params.add(assertId(filter.upTo, 'upTo'))}`);

  return parts.length ? ` where ${parts.join(' and ')}` : '';
}

function wholeLimit(value: number): string {
  if (!Number.isInteger(value) || value < 1 || value > 5000) throw new Error('limit muss zwischen 1 und 5000 liegen.');
  return String(value);
}

export function auditSelectSql(filter: AuditFilter, order: 'asc' | 'desc', limit: number): Statement {
  const params = new Params();
  const where = whereSql(filter, params);
  const text =
    `select ${ROW_COLUMNS} from ${tableName(COLLECTIONS.AUDIT_LOGS)}${where}` +
    ` order by id ${order === 'asc' ? 'asc' : 'desc'} limit ${params.add(wholeLimit(limit), 'int')}`;
  return { text, params: params.values };
}

/** Zählt höchstens bis `cap`: der Rückstand der Weiterleitung braucht keine Zahl jenseits davon. */
export function auditCountSql(filter: AuditFilter, cap: number): Statement {
  const params = new Params();
  const where = whereSql(filter, params);
  const text =
    `select count(*)::int as count from (select 1 from ${tableName(COLLECTIONS.AUDIT_LOGS)}${where}` +
    ` limit ${params.add(wholeLimit(cap), 'int')}) as capped`;
  return { text, params: params.values };
}

export function auditTotalsSql(): Statement {
  return {
    text:
      `select count(*)::int as count, min(${textExpression('timestamp')}) as oldest ` +
      `from ${tableName(COLLECTIONS.AUDIT_LOGS)}`,
    params: [],
  };
}

export async function queryAudit(
  filter: AuditFilter,
  order: 'asc' | 'desc',
  limit: number
): Promise<WithMeta<AuditLog>[]> {
  const rows = await runStatement<Row>(COLLECTIONS.AUDIT_LOGS, auditSelectSql(filter, order, limit));
  return rows.map((row) => toDoc<AuditLog>(row));
}

export async function countAudit(filter: AuditFilter, cap: number): Promise<number> {
  const rows = await runStatement<{ count: number }>(COLLECTIONS.AUDIT_LOGS, auditCountSql(filter, cap));
  return Number(rows[0]?.count ?? 0);
}

/** Wie viele Einträge es gibt und von wann der älteste ist. */
export async function auditTotals(): Promise<{ count: number; oldest: string | null }> {
  const rows = await runStatement<{ count: number; oldest: string | null }>(COLLECTIONS.AUDIT_LOGS, auditTotalsSql());
  return { count: Number(rows[0]?.count ?? 0), oldest: rows[0]?.oldest ?? null };
}
