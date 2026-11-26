import { requireSession } from '@/lib/session';
import { ok, handleError } from '@/lib/api';
import { readAuditLog, readAuditQuery } from '@/lib/audit-log/read';

/**
 * Die Einträge des Protokolls für die Seite „Protokoll": gefiltert und
 * geblättert (`from`, `to`, `actor`, `area`, `q`, `limit`, `before`).
 * Dieselbe Funktion wie hinter `GET /api/internal/audit`.
 */
export async function GET(request: Request) {
  try {
    await requireSession();
    const query = readAuditQuery(Object.fromEntries(new URL(request.url).searchParams));
    return ok(await readAuditLog(query));
  } catch (err) {
    return handleError(err);
  }
}
