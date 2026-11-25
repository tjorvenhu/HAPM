/**
 * Die letzten Zeilen des HAProxy-Logs lesen, gefiltert. Die Seite
 * „Reverse-Proxy → Logs", die interne API und der MCP-Server rufen dieselbe
 * Funktion; sie stand vorher in `app/api/haproxy/log/route.ts`.
 *
 * Gelesen wird die Datei, die der Mitschnitt schreibt (`lib/haproxy-log.ts`),
 * und nur sie: der Pfad ist eine Konstante und kommt nie aus der Anfrage.
 * Suche und Filter laufen in Node über die gelesenen Zeilen und gehen in kein
 * Kommando.
 *
 * Ohne Filter liest ein Aufruf so viele Zeilen, wie er zeigt (höchstens 2000).
 * Mit Filter liest er ein festes Fenster (`FILTER_WINDOW`) und sagt, wie groß
 * es war. Die Seite pollt, deshalb ist beides eine feste Obergrenze und kein
 * Zeitraum.
 *
 * ── Ehrliche Nullwerte ──
 *
 * Eine leere Liste hieße „HAProxy hat nichts geschrieben". Das stimmt nur, wenn
 * die Datei da ist und der Mitschnitt läuft. Deshalb gehen `exists` und der
 * Zustand des Mitschnitts mit.
 */

import fs from 'node:fs/promises';
import { ApiError } from '../api';
import { msg } from '../i18n';
import { sshExec } from '../ssh';
import { getSSHConfig, localServer } from '../helpers';
import { HAPROXY_LOG_FILE, logFollowerStatus } from '../haproxy-log';
import {
  clampLines,
  filterEntries,
  isLogFilter,
  parseLogOutput,
  tailCommand,
  FILTER_WINDOW,
  MAX_QUERY_CHARS,
  type HaproxyLogView,
} from './log-view';

const READ_MS = 30_000;

/** Die Parameter wie in der Adresse der Seite: `lines`, `filter`, `q`. Alles darf fehlen. */
export async function readHaproxyLog(params: {
  lines?: string | number | null;
  filter?: string | null;
  q?: string | null;
}): Promise<HaproxyLogView> {
  const limit = clampLines(params.lines ?? null);
  const filterParam = params.filter ?? 'all';
  const filter = isLogFilter(filterParam) ? filterParam : 'all';
  const query = (params.q ?? '').trim().slice(0, MAX_QUERY_CHARS);
  const narrowed = filter !== 'all' || query !== '';
  const window = narrowed ? FILTER_WINDOW : limit;

  const follower = logFollowerStatus();
  const base = {
    collectedAt: new Date().toISOString(),
    file: HAPROXY_LOG_FILE,
    follower: { started: follower.started, connected: follower.connected, last: follower.last },
    filter,
    query,
    limit,
    window,
  };

  let stat;
  try {
    stat = await fs.stat(HAPROXY_LOG_FILE);
  } catch {
    return { ...base, exists: false, size: null, modifiedAt: null, scanned: 0, matched: 0, entries: [] };
  }

  const result = await sshExec(await getSSHConfig(localServer()), tailCommand(HAPROXY_LOG_FILE, window), READ_MS);
  if (result.code !== 0) {
    throw new ApiError(msg('Das HAProxy-Log konnte nicht gelesen werden.'), 500);
  }

  const all = parseLogOutput(result.stdout);
  const { entries, matched } = filterEntries(all, { filter, query, limit });

  return {
    ...base,
    exists: true,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    scanned: all.length,
    matched,
    entries,
  };
}
