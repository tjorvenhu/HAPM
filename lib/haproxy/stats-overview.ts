/**
 * Die Zeitreihe des Reverse-Proxys für einen Zeitraum, samt Summen und der
 * Abschnitte, die darin Verkehr hatten.
 *
 * Nur lesend, und nur aus der Datenbank: der Lauf, der sie füllt, hängt am
 * Scheduler (`stats-collect.ts`). HAProxy selbst wird hier nicht gefragt,
 * sonst dauerte jeder Aufruf so lange wie eine Abfrage des Stats-Sockets.
 * Gerechnet wird in `stats-series.ts`. Gebraucht von der Statistik-Seite
 * (`app/api/haproxy/stats`) und vom MCP-Server.
 */

import { readHaproxyMetrics } from './stats-collect';
import { proxyServers } from './internal';
import { bucketMs, bucketise, foldInBackends, sumUp, type Point } from './stats-series';

export interface StatsOverview {
  hours: number;
  bucketMinutes: number;
  series: Point[];
  /** Wie viele Messpunkte dahinterstehen. Nach dem Start von HAPM gibt es genau
   *  einen, und der ist ein Zählerstand und kein Zeitraum: die Momentanwerte
   *  stehen dann schon da, jede Differenz erst nach der zweiten Runde. */
  samples: number;
  totals: Record<string, number | null>;
  services: { scope: string; serverId: string; requests: number; serverName: string }[];
  proxies: { $id: string; name: string }[];
}

export function clampHours(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(24 * 30, Math.max(1, Math.floor(value)));
}

export async function readStatsOverview(options: {
  hours: number;
  scope?: string;
  serverId?: string;
}): Promise<StatsOverview> {
  const hours = clampHours(options.hours);
  const { scope, serverId } = options;
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const width = bucketMs(hours);

  /*
   * MIT `scope` ist die BACKEND-Zeile gemeint, und die Einschränkung ist
   * Pflicht: ein `listen`-Abschnitt (die TCP-Weiterleitungen) taucht unter
   * EINEM Namen mit beiden Sammelzeilen auf. Ohne `kind` käme jede seiner
   * Sitzungen doppelt in die Summe.
   *
   * Die Backend-Zeilen werden IMMER ungefiltert gelesen, auch im Drilldown.
   * Sie tragen zwei Dinge: die Reihe des einen Dienstes und die Liste der
   * Abschnitte. Auf `scope` eingeschränkt stünde in dieser Liste genau der
   * Dienst, in dem man gerade steckt, und damit ließe sich von dort nirgendwo
   * mehr hin.
   */
  const backendRows = await readHaproxyMetrics({ since, kind: 'backend', serverId });

  let series: Point[];
  if (scope) {
    series = bucketise(
      backendRows.filter((row) => row.scope === scope),
      width
    );
  } else {
    // Ohne `scope` sind BEIDE Sorten nötig: die Flussgrößen kommen aus den
    // Frontends (Begründung bei `foldInBackends`), die vier reinen
    // Backend-Spalten aus den Backends.
    const frontendRows = await readHaproxyMetrics({ since, kind: 'frontend', serverId });
    series = foldInBackends(bucketise(frontendRows, width), bucketise(backendRows, width));
  }

  // Aus der Zeitreihe und nicht aus der laufenden Konfiguration: ein Dienst,
  // der gestern gelöscht wurde, hat gestern Verkehr gehabt.
  const seen = new Map<string, { scope: string; serverId: string; requests: number }>();
  for (const row of backendRows) {
    const key = `${row.serverId}|${row.scope}`;
    const entry = seen.get(key) ?? { scope: row.scope, serverId: row.serverId, requests: 0 };
    entry.requests += row.requests ?? 0;
    seen.set(key, entry);
  }

  const servers = await proxyServers();
  const names = new Map(servers.map((server) => [server.$id, server.name]));

  return {
    hours,
    bucketMinutes: width / 60_000,
    series,
    samples: series.length,
    totals: sumUp(series),
    services: [...seen.values()]
      .map((entry) => ({ ...entry, serverName: names.get(entry.serverId) ?? '—' }))
      .sort((a, b) => b.requests - a.requests),
    proxies: servers.map((server) => ({ $id: server.$id, name: server.name })),
  };
}
