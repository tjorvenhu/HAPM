import { requireSession } from '@/lib/session';
import { ok, handleError } from '@/lib/api';
import { readLiveStats } from '@/lib/haproxy/stats-overview';

/**
 * Die Live-Kennzahlen: Anfragen und Datenrate pro Sekunde, Antwortzeit,
 * Verbindungen, Fehlerquote, dazu die letzte halbe Stunde als Verlauf.
 *
 * Wie `/api/haproxy/stats` nur aus der Datenbank. Die Übersicht und die
 * Statistik-Seite fragen hier alle fünfzehn Sekunden (`LIVE_POLL_MS`); den
 * Socket fragt weiter nur der Sammler, einmal je Minute. Gerechnet wird in
 * `lib/haproxy/stats-live.ts`.
 */
export async function GET(request: Request) {
  try {
    await requireSession();

    const url = new URL(request.url);
    return ok(await readLiveStats({ scope: url.searchParams.get('scope')?.trim() || undefined }));
  } catch (err) {
    return handleError(err);
  }
}
