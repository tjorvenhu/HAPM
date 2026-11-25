/**
 * Was HAPM zuletzt in jede Fehlerdatei geschrieben hat: Collection
 * `page_files`, je Pfad eine Zeile mit der Prüfsumme.
 *
 * Danach entscheidet `isOwnErrorFile` (`error-pages.ts`), ob eine Datei nach
 * einem Update oder einer geänderten Darstellung ohne Rückfrage neu
 * geschrieben werden darf. Die Datei bleibt die Wahrheit: hier steht nur, was
 * HAPM hinterlassen hat, nicht was dort steht.
 *
 * Geschrieben wird nach jedem erfolgreichen Schreibvorgang
 * (`updateErrorPages`, nach Prüfung und Reload) und beim ersten Anlegen
 * (`lib/bootstrap.ts`). Ein gescheiterter Vorgang stellt die Dateien zurück und
 * hinterlässt hier nichts.
 */

import { createHash } from 'node:crypto';
import { COLLECTIONS, createDocument, getDocument, listAll, updateDocument } from '../db';

interface PageFileRow {
  path: string;
  digest: string;
  writtenAt: string;
}

export function pageFileDigest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Pfad → Prüfsumme dessen, was HAPM zuletzt dort geschrieben hat. */
export async function writtenPageDigests(): Promise<Map<string, string>> {
  const rows = await listAll<PageFileRow>(COLLECTIONS.PAGE_FILES);
  return new Map(rows.map((row) => [row.path, row.digest]));
}

/** Merkt sich, was gerade geschrieben wurde. Wirft nie: die Dateien stehen schon. */
export async function rememberWrittenPages(files: { path: string; content: string }[]): Promise<void> {
  const writtenAt = new Date().toISOString();
  for (const file of files) {
    const row: PageFileRow = { path: file.path, digest: pageFileDigest(file.content), writtenAt };
    try {
      const exists = await getDocument(COLLECTIONS.PAGE_FILES, file.path).then(
        () => true,
        () => false
      );
      if (exists) await updateDocument<PageFileRow>(COLLECTIONS.PAGE_FILES, file.path, row);
      else await createDocument<PageFileRow>(COLLECTIONS.PAGE_FILES, row, file.path);
    } catch (err) {
      console.error(`[fehlerseiten] ${file.path} nicht vermerkt:`, err instanceof Error ? err.message : err);
    }
  }
}
