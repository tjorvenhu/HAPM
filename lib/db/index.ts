/**
 * Die Datenbank-Fassade. Alles geht hier durch, keine Datei außerhalb von
 * `lib/db/` öffnet die Datenbank selbst.
 *
 * Die Fassade spricht in Dokumenten und Collections: `listDocuments`,
 * `listAll`, `getSingleton` und die anderen. Dahinter liegt Postgres, mit
 * Dokumenten als `jsonb` statt einer Spalte je Feld, siehe `postgres-driver.ts`.
 */

import { COLLECTIONS } from '../types';
import { Query, ID, type Predicate } from './query';
import { postgresDriver } from './postgres-driver';
import type { WithMeta } from './driver';

export { COLLECTIONS, Query, ID };
export type { Predicate, WithMeta };
export { NotFoundError } from './driver';

export function listDocuments<T>(collectionId: string, queries: Predicate[] = []) {
  return postgresDriver.list<T>(collectionId, queries);
}

export function getDocument<T>(collectionId: string, documentId: string) {
  return postgresDriver.get<T>(collectionId, documentId);
}

export function createDocument<T>(collectionId: string, data: Partial<T>, id?: string) {
  return postgresDriver.create<T>(collectionId, data, id);
}

export function updateDocument<T>(collectionId: string, documentId: string, data: Partial<T>) {
  return postgresDriver.update<T>(collectionId, documentId, data);
}

export function deleteDocument(collectionId: string, documentId: string) {
  return postgresDriver.remove(collectionId, documentId);
}

/**
 * Delete by criteria — for housekeeping, not for business logic.
 *
 * Returns the number of rows removed. `Query.limit(n)` bounds a single run, so
 * a backlog is worked off over several passes rather than in one long lock.
 *
 * The call sites are the retention paths: old metrics, runs and audit entries
 * (`lib/scheduler.ts`), backup runs, notification state. Deleting a *specific*
 * document stays `deleteDocument` — this one takes no id and is therefore the
 * wrong tool anywhere a check has to run on the document first.
 */
export function deleteWhere(collectionId: string, queries: Predicate[]) {
  return postgresDriver.removeWhere(collectionId, queries);
}

/**
 * Read a singleton document, creating it with `defaults` if it does not exist yet.
 * For collections that hold exactly one row.
 */
export async function getSingleton<T>(
  collectionId: string,
  documentId: string,
  defaults: Partial<T>
): Promise<WithMeta<T>> {
  try {
    return await getDocument<T>(collectionId, documentId);
  } catch {
    try {
      return await createDocument<T>(collectionId, defaults, documentId);
    } catch {
      // Lost a create race against a concurrent request — read the winner.
      return await getDocument<T>(collectionId, documentId);
    }
  }
}

/**
 * List every document in a collection, following pagination.
 *
 * Several call sites need the full set (the metric series, for one). A
 * thousand rows per round: Postgres has no ceiling on a page, and walking
 * `haproxy_metrics` in smaller steps would be an avoidable pile of round
 * trips.
 *
 * ── Why this walks a key instead of counting offsets ──
 *
 * The obvious spelling is `limit(page) + offset(k*page)`, and it is wrong
 * twice over.
 *
 * The correctness half: an `OFFSET` without an `ORDER BY` is not a position.
 * Postgres makes no promise that two queries differing only in their offset
 * see rows in the same sequence — a concurrent update can move a row to a new
 * heap location, and the second page then either repeats it or skips it. The
 * result is a full-collection read that can quietly return a row twice, or
 * lose one, and nothing downstream would notice.
 *
 * The cost half: `OFFSET k` makes the server produce and discard k rows. The
 * whole walk is therefore quadratic in the row count. On a small table that is
 * invisible, which is exactly what makes it a trap rather than a bug: it stays
 * invisible until someone points it at a table that grew.
 *
 * Both go away by paging on the primary key. `$id` is UUIDv7 (see `uniqueId`),
 * so it is unique, never reused, and already the index Postgres reads anyway.
 * Each page asks for ids strictly greater than the last one seen, which is a
 * position that means something.
 *
 * The caller's own `Query.orderAsc(...)` cannot be honoured while doing this —
 * a keyset walk has to order by the key it walks. That is not a loss: a caller
 * that wants everything and wants it sorted should sort the result, and no
 * current call site passes an order to `listAll`. Passing one now throws
 * rather than being silently ignored.
 */
export async function listAll<T>(collectionId: string, queries: Predicate[] = []) {
  if (queries.some((q) => q.kind === 'order')) {
    throw new Error(
      'listAll sortiert selbst nach $id und kann keine eigene Sortierung annehmen — ' +
        'das Ergebnis nach dem Laden sortieren.'
    );
  }

  const out: WithMeta<T>[] = [];

  const page = 1000;
  let after: string | null = null;

  for (;;) {
    const batch: WithMeta<T>[] = await listDocuments<T>(collectionId, [
      ...queries,
      ...(after === null ? [] : [Query.greaterThan('$id', after)]),
      Query.orderAsc('$id'),
      Query.limit(page),
    ]);
    out.push(...batch);
    if (batch.length < page) break;
    after = batch[batch.length - 1].$id;
  }

  return out;
}
