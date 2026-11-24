/**
 * Die Datenbank-Fassade im Speicher, für die Tests des Bereichs „DNS".
 *
 * Nur was `lib/dns/store.ts` und `lib/dns/connect.ts` von ihr brauchen, mit
 * demselben Verhalten: ein fehlendes Dokument wirft, `update` mischt statt zu
 * ersetzen, `Query.equal` vergleicht ein Feld.
 */

type Doc = Record<string, unknown>;

interface Equal {
  field: string;
  value: unknown;
}

const collections = new Map<string, Map<string, Doc>>();
let counter = 0;

function table(collectionId: string): Map<string, Doc> {
  let rows = collections.get(collectionId);
  if (!rows) collections.set(collectionId, (rows = new Map()));
  return rows;
}

export function resetFakeDb(): void {
  collections.clear();
  counter = 0;
}

export function rowsOf(collectionId: string): Doc[] {
  return [...table(collectionId).values()];
}

export const Query = {
  equal: (field: string, value: unknown): Equal => ({ field, value }),
};

export async function listAll(collectionId: string, queries: Equal[] = []): Promise<Doc[]> {
  return rowsOf(collectionId)
    .filter((row) => queries.every((query) => row[query.field] === query.value))
    .map((row) => ({ ...row }));
}

export async function getDocument(collectionId: string, documentId: string): Promise<Doc> {
  const row = table(collectionId).get(documentId);
  if (!row) throw new Error(`Dokument ${documentId} in ${collectionId} nicht gefunden.`);
  return { ...row };
}

export async function createDocument(collectionId: string, data: Doc, id?: string): Promise<Doc> {
  const $id = id ?? `doc_${(counter += 1)}`;
  const now = new Date().toISOString();
  const row = { ...data, $id, $createdAt: now, $updatedAt: now };
  table(collectionId).set($id, row);
  return { ...row };
}

export async function updateDocument(collectionId: string, documentId: string, data: Doc): Promise<Doc> {
  const rows = table(collectionId);
  const row = rows.get(documentId);
  if (!row) throw new Error(`Dokument ${documentId} in ${collectionId} nicht gefunden.`);
  const next = { ...row, ...data, $updatedAt: new Date().toISOString() };
  rows.set(documentId, next);
  return { ...next };
}
