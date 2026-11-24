import { requireSession } from '@/lib/session';
import { ok, handleError } from '@/lib/api';
import { readHaproxyMetrics } from '@/lib/haproxy/stats-collect';
import { proxyServers } from '@/lib/haproxy/internal';
import {
  bucketMs,
  bucketise,
  foldInBackends,
  sumUp,
  type Point,
} from '@/lib/haproxy/stats-series';

/**
 * Die Zeitreihe des Reverse-Proxys.
 *
 * Nur lesend, und nur aus der Datenbank: der Lauf, der sie füllt, hängt am
 * Scheduler (`lib/haproxy/stats-collect.ts`). Diese Route fragt HAProxy nicht
 * selbst — sonst dauerte jeder Seitenaufruf so lange wie eine Abfrage des
 * Stats-Sockets, und die Seite pollt.
 *
 * Gerechnet wird in `lib/haproxy/stats-series.ts`: das Raster, die drei Arten
 * des Zusammenfassens und das Nachtragen der reinen Backend-Spalten. Hier steht
 * nur, was gelesen wird und was zurückgeht.
 */
export async function GET(request: Request) {
  try {
    await requireSession();

    const url = new URL(request.url);
    const hours = clamp(Number(url.searchParams.get('hours') ?? 24), 1, 24 * 30);
    const scope = url.searchParams.get('scope')?.trim() || undefined;
    const serverId = url.searchParams.get('serverId')?.trim() || undefined;

    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
    const width = bucketMs(hours);

    /*
     * MIT `scope` ist die BACKEND-Zeile gemeint, und die Einschränkung ist
     * Pflicht: ein `listen`-Abschnitt (die TCP-Weiterleitungen) taucht unter
     * EINEM Namen mit beiden Sammelzeilen auf. Ohne `kind` käme jede seiner
     * Sitzungen doppelt in die Summe.
     */
    /*
     * Die Backend-Zeilen werden IMMER ungefiltert gelesen, auch im Drilldown.
     * Sie tragen zwei Dinge: die Reihe des einen Dienstes und die Liste, aus
     * der die Auswahl oben rechts besteht. Auf `scope` eingeschränkt gelesen
     * stünde in dieser Auswahl genau der Dienst, in dem man gerade steckt — und
     * damit ließe sich von dort nirgendwo mehr hin.
     */
    const backendRows = await readHaproxyMetrics({ since, kind: 'backend', serverId });

    let series: Point[];
    if (scope) {
      series = bucketise(
        backendRows.filter((row) => row.scope === scope),
        width
      );
    } else {
      /*
       * Ohne `scope` sind BEIDE Sorten nötig, und zwar für verschiedene Felder:
       * die Flussgrößen kommen aus den Frontends (Begründung bei
       * `foldInBackends`), die vier reinen Backend-Spalten aus den Backends.
       */
      const frontendRows = await readHaproxyMetrics({ since, kind: 'frontend', serverId });
      series = foldInBackends(bucketise(frontendRows, width), bucketise(backendRows, width));
    }

    /*
     * Welche Abschnitte es in diesem Zeitraum überhaupt gab.
     *
     * Aus der Zeitreihe und nicht aus der laufenden Konfiguration: ein Dienst,
     * der gestern gelöscht wurde, hat gestern Verkehr gehabt, und die Auswahl
     * soll ihn zeigen können. Umgekehrt steht ein heute angelegter Dienst ohne
     * eine einzige Messung noch nicht darin — er hat auch nichts zu zeigen.
     */
    const seen = new Map<string, { scope: string; serverId: string; requests: number }>();
    for (const row of backendRows) {
      const key = `${row.serverId}|${row.scope}`;
      const entry = seen.get(key) ?? { scope: row.scope, serverId: row.serverId, requests: 0 };
      entry.requests += row.requests ?? 0;
      seen.set(key, entry);
    }

    const servers = await proxyServers();
    const names = new Map(servers.map((server) => [server.$id, server.name]));

    return ok({
      hours,
      bucketMinutes: width / 60_000,
      series,
      /**
       * Wie viele Messpunkte überhaupt dahinterstehen.
       *
       * Die Oberfläche braucht die Zahl, um den einen Fall zu erklären, der wie
       * ein Fehler aussieht und keiner ist: nach dem Start von HAPM gibt es
       * genau EINE Probe, und die ist ein Zählerstand und kein Zeitraum. Die
       * Momentanwerte (gleichzeitige Sitzungen) stehen dann schon da, jede
       * Differenz erst nach der zweiten Runde. Ohne diese Zahl steht in fünf
       * Diagrammen „keine Messwerte", und das liest sich wie „kaputt".
       */
      samples: series.length,
      totals: sumUp(series),
      services: [...seen.values()]
        .map((entry) => ({ ...entry, serverName: names.get(entry.serverId) ?? '—' }))
        .sort((a, b) => b.requests - a.requests),
      proxies: servers.map((server) => ({ $id: server.$id, name: server.name })),
    });
  } catch (err) {
    return handleError(err);
  }
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, Math.floor(value)));
}
