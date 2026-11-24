/**
 * Die Datenbank-Fassade im Speicher, für Tests der Benachrichtigungen.
 *
 * Nur was `lib/settings.ts` und `lib/notifications/` von ihr brauchen, mit
 * demselben Verhalten: ein fehlendes Dokument wirft `NotFoundError`, `update`
 * mischt statt zu ersetzen. So hängen die Tests an keinem Treiber.
 */

type Doc = Record<string, unknown>;

export class NotFoundError extends Error {
  constructor(collectionId: string, documentId: string) {
    super(`Dokument ${documentId} in ${collectionId} nicht gefunden.`);
    this.name = 'NotFoundError';
  }
}

const collections = new Map<string, Map<string, Doc>>();
let failing = false;

function table(collectionId: string): Map<string, Doc> {
  if (failing) throw new Error('Die Datenbank antwortet nicht.');
  let rows = collections.get(collectionId);
  if (!rows) collections.set(collectionId, (rows = new Map()));
  return rows;
}

export function resetFakeDb(): void {
  collections.clear();
  failing = false;
}

/** Jeder Zugriff wirft, wie bei einer Datenbank, die weg ist. */
export function breakFakeDb(broken = true): void {
  failing = broken;
}

export function rowsOf(collectionId: string): Doc[] {
  return [...(collections.get(collectionId)?.values() ?? [])];
}

export async function getDocument(collectionId: string, documentId: string): Promise<Doc> {
  const row = table(collectionId).get(documentId);
  if (!row) throw new NotFoundError(collectionId, documentId);
  return { ...row };
}

export async function createDocument(collectionId: string, data: Doc, id = `id_${Math.random()}`): Promise<Doc> {
  const now = new Date().toISOString();
  const row = { ...data, $id: id, $createdAt: now, $updatedAt: now };
  table(collectionId).set(id, row);
  return { ...row };
}

export async function updateDocument(collectionId: string, documentId: string, data: Doc): Promise<Doc> {
  const rows = table(collectionId);
  const row = rows.get(documentId);
  if (!row) throw new NotFoundError(collectionId, documentId);
  const next = { ...row, ...data, $updatedAt: new Date().toISOString() };
  rows.set(documentId, next);
  return { ...next };
}

export async function getSingleton(collectionId: string, documentId: string, defaults: Doc): Promise<Doc> {
  try {
    return await getDocument(collectionId, documentId);
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
    return createDocument(collectionId, defaults, documentId);
  }
}

interface LessThan {
  field: string;
  value: string;
}

export const Query = {
  lessThan: (field: string, value: string): LessThan => ({ field, value }),
};

export async function deleteWhere(collectionId: string, queries: LessThan[]): Promise<number> {
  const rows = table(collectionId);
  let removed = 0;
  for (const [id, row] of rows) {
    const matches = queries.every((query) => {
      const value = row[query.field];
      return typeof value === 'string' && value < query.value;
    });
    if (matches) {
      rows.delete(id);
      removed += 1;
    }
  }
  return removed;
}
