import { ok, fail, handleError } from '@/lib/api';
import { bootstrapState } from '@/lib/bootstrap';
import { databaseState } from '@/lib/setup-db';

// Liest keinen Cookie und keine Anfrage. Ohne diese Zeile dürfte Next die Antwort beim Bauen festhalten.
export const dynamic = 'force-dynamic';

/**
 * Der Healthcheck des Containers (Dockerfile). Öffentlich und ohne Sitzung.
 *
 * Deshalb steht hier nur, ob der Prozess antwortet und wie weit die
 * Ersteinrichtung ist: kein Schritt, kein Pfad, keine Fehlermeldung. Die
 * Einzelheiten zeigt die Übersicht hinter der Anmeldung.
 */
export async function GET() {
  try {
    // Ohne Datenbank ist nichts bereit. Der Text der Störung steht im Log des Containers.
    if (databaseState().status !== 'ok') return fail('Die Datenbank ist nicht bereit.', 503);
    return ok({ status: 'ok', bootstrap: bootstrapState().status });
  } catch (err) {
    return handleError(err);
  }
}
