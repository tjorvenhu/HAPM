/**
 * The contract the facade in `lib/db/index.ts` stands on.
 *
 * ── Why an interface for a single implementation ──
 *
 * It has exactly one implementer, and it stays anyway, because it is not a
 * seam for a second driver — it is the written-down size of the facade. Six
 * operations, no transactions, no joins. Stated as a type, adding a seventh is
 * a deliberate edit to this file with a reason next to it; stated only as
 * whatever `postgres-driver.ts` happens to export, the surface grows by
 * whoever needed something once. Richer SQL belongs in the call sites that ask
 * for it directly, not in the layer that every module imports blindly.
 *
 * ── Why there is a sixth operation ──
 *
 * `removeWhere` is not richer SQL — it is the same work stated once instead of
 * N times. The retention paths delete by criteria (old metrics, runs and audit
 * entries in `lib/scheduler.ts`, backup runs, notification state). Spelled with
 * the other five operations that is "read a page, then delete each row on its
 * own": one round trip per row, every night, on a collection that gains rows
 * every minute (`haproxy_metrics`). Under Postgres the identical intent is one
 * statement.
 */

import type { Predicate } from './query';

export type WithMeta<T> = T & { $id: string; $createdAt: string; $updatedAt: string };

/**
 * `list` returns 25 rows when no limit is given.
 *
 * The number is a convention, and it stays because many call sites read a page
 * without asking for one, and several of them show that page to a user.
 * Raising it would change what those pages contain without anyone editing
 * them. Whoever wants everything calls `listAll`; whoever wants a different
 * page says so with `Query.limit`. Same rule in CLAUDE.md.
 */
export const DEFAULT_LIMIT = 25;

/**
 * „Die Zeile gibt es nicht" — unterscheidbar von „es ging etwas schief".
 *
 * ── Warum das eine eigene Klasse braucht ──
 *
 * `get` und `update` werfen, wenn kein Dokument passt; mehrere Aufrufstellen
 * bauen darauf ein Anlegen-falls-nicht-vorhanden. Wäre der Wurf ein nacktes
 * `Error`, müssten sie ihn am Text erkennen oder — häufiger — **jeden**
 * Fehler als „gibt es nicht" deuten.
 *
 * Der Schaden daraus ist kein gedachter: eine Aufrufstelle, die bei jedem
 * Fehler aus `update` auf `create` zurückfällt, scheitert nach einem
 * Serialisierungsfehler an der bestehenden Zeile mit `duplicate key` — und im
 * Log steht dann ein Schlüsselkonflikt, wo in Wahrheit ein Typfehler die
 * Ursache ist. Die Fehlersuche läuft tagelang in die falsche Richtung.
 *
 * Ein Fangen, das nicht unterscheidet, verwandelt jeden Fehler in den, mit dem
 * man gerechnet hat.
 */
export class NotFoundError extends Error {
  constructor(collectionId: string, documentId: string) {
    super(`Dokument ${documentId} in ${collectionId} nicht gefunden.`);
    this.name = 'NotFoundError';
  }
}

export interface DbDriver {
  readonly name: 'postgres';
  list<T>(collectionId: string, predicates: Predicate[]): Promise<WithMeta<T>[]>;
  /** Throws when the document does not exist — `getSingleton` depends on it. */
  get<T>(collectionId: string, documentId: string): Promise<WithMeta<T>>;
  create<T>(collectionId: string, data: Partial<T>, id?: string): Promise<WithMeta<T>>;
  update<T>(collectionId: string, documentId: string, data: Partial<T>): Promise<WithMeta<T>>;
  remove(collectionId: string, documentId: string): Promise<void>;
  /**
   * Delete every document matching the predicates; returns how many went.
   *
   * `Query.limit(n)` caps a single run — the callers use it to keep a
   * housekeeping pass bounded, so that a backlog is worked off over several
   * runs instead of one run holding a lock for minutes. Ordering predicates are
   * ignored: which rows go is decided by the conditions, not by a sequence.
   */
  removeWhere(collectionId: string, predicates: Predicate[]): Promise<number>;
}
