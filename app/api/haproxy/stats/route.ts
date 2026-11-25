import { requireSession } from '@/lib/session';
import { ok, handleError } from '@/lib/api';
import { readStatsOverview } from '@/lib/haproxy/stats-overview';

/**
 * Die Zeitreihe des Reverse-Proxys.
 *
 * Nur lesend, und nur aus der Datenbank: der Lauf, der sie füllt, hängt am
 * Scheduler (`lib/haproxy/stats-collect.ts`). Diese Route fragt HAProxy nicht
 * selbst — sonst dauerte jeder Seitenaufruf so lange wie eine Abfrage des
 * Stats-Sockets, und die Seite pollt.
 *
 * Was gelesen und wie zusammengefasst wird, steht in
 * `lib/haproxy/stats-overview.ts`; der MCP-Server ruft dieselbe Funktion.
 */
export async function GET(request: Request) {
  try {
    await requireSession();

    const url = new URL(request.url);
    return ok(
      await readStatsOverview({
        hours: Number(url.searchParams.get('hours') ?? 24),
        scope: url.searchParams.get('scope')?.trim() || undefined,
        serverId: url.searchParams.get('serverId')?.trim() || undefined,
      })
    );
  } catch (err) {
    return handleError(err);
  }
}
