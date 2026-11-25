import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError } from '@/lib/api';
import { readStatsOverview } from '@/lib/haproxy/stats-overview';

/**
 * Die Zeitreihe des Reverse-Proxys aus der Datenbank (jede Minute gesammelt):
 * `?hours=` (1 bis 720, Vorgabe 24), `?scope=` ein Backend. Dieselbe Funktion
 * wie die Statistik-Seite und `get_traffic_stats`, dieselbe Antwort wie
 * `/api/haproxy/stats`.
 */
export async function GET(request: Request) {
  try {
    await requireServiceToken(request);
    const url = new URL(request.url);
    return ok(
      await readStatsOverview({
        hours: Number(url.searchParams.get('hours') ?? 24),
        scope: url.searchParams.get('scope')?.trim() || undefined,
      })
    );
  } catch (err) {
    return handleError(err);
  }
}
