/**
 * Queries as data.
 *
 * The call sites write `Query.equal('serverId', id)`. What comes back is a
 * `Predicate` object and not a finished string: a string carries no structure,
 * and `sql.ts` has to translate field, operator and value each on its own (the
 * field becomes a `jsonb` path, the value a bound parameter).
 *
 * The operator set is not a design; it is a census of what the call sites use:
 * equal, notEqual, lessThan(Equal), greaterThan(Equal), isNull, isNotNull,
 * limit, offset, orderAsc, orderDesc. Anything added here has to be added to
 * `sql.ts` as well; `tests/db/sql.test.ts` pins what each one becomes.
 */

export type QueryValue = string | number | boolean;

export type WhereOp = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'isNull' | 'isNotNull';

export type Predicate =
  | { kind: 'where'; op: WhereOp; field: string; value?: QueryValue | QueryValue[] }
  | { kind: 'order'; field: string; dir: 'asc' | 'desc' }
  | { kind: 'limit'; value: number }
  | { kind: 'offset'; value: number };

function where(op: WhereOp, field: string, value?: QueryValue | QueryValue[]): Predicate {
  return { kind: 'where', op, field, value };
}

export const Query = {
  equal: (field: string, value: QueryValue | QueryValue[]) => where('eq', field, value),
  notEqual: (field: string, value: QueryValue) => where('ne', field, value),
  lessThan: (field: string, value: QueryValue) => where('lt', field, value),
  lessThanEqual: (field: string, value: QueryValue) => where('lte', field, value),
  greaterThan: (field: string, value: QueryValue) => where('gt', field, value),
  greaterThanEqual: (field: string, value: QueryValue) => where('gte', field, value),
  isNull: (field: string) => where('isNull', field),
  isNotNull: (field: string) => where('isNotNull', field),
  limit: (value: number): Predicate => ({ kind: 'limit', value }),
  offset: (value: number): Predicate => ({ kind: 'offset', value }),
  orderAsc: (field: string): Predicate => ({ kind: 'order', field, dir: 'asc' }),
  orderDesc: (field: string): Predicate => ({ kind: 'order', field, dir: 'desc' }),
};

/** Split a predicate list into its parts, the form `sql.ts` builds statements from. */
export function partition(predicates: Predicate[]) {
  const wheres: Extract<Predicate, { kind: 'where' }>[] = [];
  const orders: Extract<Predicate, { kind: 'order' }>[] = [];
  let limit: number | null = null;
  let offset: number | null = null;

  for (const p of predicates) {
    if (p.kind === 'where') wheres.push(p);
    else if (p.kind === 'order') orders.push(p);
    // A repeated limit/offset is the last one winning. listAll() relies on
    // it: it appends its own paging to whatever the caller already passed.
    else if (p.kind === 'limit') limit = p.value;
    else offset = p.value;
  }

  return { wheres, orders, limit, offset };
}

/**
 * UUIDv7 as 32 hex characters.
 *
 * Not v4, because the leading 48 bits are a millisecond timestamp: ids sort by
 * creation time, which keeps B-tree inserts at the right edge of the primary
 * key instead of scattering them across the whole index. On `haproxy_metrics`
 * — new rows every minute — that is the difference between appending to a page
 * and dirtying a random one on every insert.
 *
 * The ordering is millisecond-granular and no finer: the remaining 74 bits are
 * random, so two ids minted in the same millisecond sort arbitrarily against
 * each other. That is enough for index locality, and it is NOT enough to use as
 * a tiebreaker for rows that share a timestamp.
 *
 * No dashes, and that is not to change: every id written so far is dashless,
 * and a generator that started emitting dashes would make the format of an id
 * depend on when the row was written. Nothing reads ids that way today, which
 * is exactly the kind of assumption that is cheap to keep true and expensive
 * to discover broken.
 */
export function uniqueId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  const ms = Date.now();
  bytes[0] = (ms / 2 ** 40) & 0xff;
  bytes[1] = (ms / 2 ** 32) & 0xff;
  bytes[2] = (ms / 2 ** 24) & 0xff;
  bytes[3] = (ms / 2 ** 16) & 0xff;
  bytes[4] = (ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;

  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant

  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export const ID = { unique: uniqueId };
