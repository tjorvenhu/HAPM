import { listAll } from '@/lib/db';
import { COLLECTIONS, type SavedTargetDoc } from '@/lib/types';
import { jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import {
  normalizeSavedTarget,
  validateSavedTarget,
  type SavedTarget,
  type SavedTargetInput,
} from './saved-targets';

/** Die Seite der Datenbank zu `saved-targets.ts`, für die Routen unter `/api/haproxy/targets`. */

export function toSavedTarget(doc: SavedTargetDoc): SavedTarget {
  return { $id: doc.$id, name: doc.name, host: doc.host, port: doc.port ?? null };
}

/** Die Eingabe geprüft, oder eine Meldung. Zwei Ziele gleichen Namens wären in der Auswahl nicht zu unterscheiden. */
export async function readSavedTarget(request: Request, exceptId: string | null): Promise<SavedTargetInput> {
  const target = normalizeSavedTarget(await jsonBody<Record<string, unknown>>(request));
  const invalid = validateSavedTarget(target);
  if (invalid) throw new ApiError(msg(invalid));
  const existing = await listAll<SavedTargetDoc>(COLLECTIONS.SAVED_TARGETS);
  const clash = existing.find((doc) => doc.$id !== exceptId && doc.name.toLowerCase() === target.name.toLowerCase());
  if (clash) throw new ApiError(msg('Ein Ziel namens „{name}" gibt es schon.', { name: target.name }), 409);
  return target;
}
