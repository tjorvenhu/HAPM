import { handleError } from '@/lib/api';
import { handleNodeRequest } from '@/lib/sync/receive';

export const dynamic = 'force-dynamic';

/**
 * Der Endpunkt für andere Knoten: Auskunft geben und einen Stand annehmen.
 *
 * Ohne Sitzung und ohne API-Key. Der Zugang ist der Kopplungsschlüssel, mit
 * dem Anfrage und Antwort verschlüsselt sind. Alle Prüfungen und ihre
 * Reihenfolge stehen in `lib/sync/receive.ts`, hier steht mit Absicht nichts
 * davor: eine Zeile, die vor der Prüfung den Rumpf liest oder die Datenbank
 * fragt, arbeitete für einen Fremden.
 */
export async function POST(request: Request) {
  try {
    return await handleNodeRequest(request);
  } catch (err) {
    return handleError(err);
  }
}
