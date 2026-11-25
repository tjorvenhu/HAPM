import fs from 'node:fs/promises';
import { requireSession } from '@/lib/session';
import { ok, handleError, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { sshExec } from '@/lib/ssh';
import { getSSHConfig, localServer } from '@/lib/helpers';
import { HAPROXY_LOG_FILE, logFollowerStatus } from '@/lib/haproxy-log';
import {
  clampLines,
  filterEntries,
  isLogFilter,
  parseLogOutput,
  tailCommand,
  FILTER_WINDOW,
  MAX_QUERY_CHARS,
  type HaproxyLogView,
} from '@/lib/haproxy/log-view';

/**
 * Die letzten Zeilen des HAProxy-Logs für die Seite „Reverse-Proxy → Logs".
 *
 * Gelesen wird die Datei, die der Mitschnitt schreibt (`lib/haproxy-log.ts`),
 * und nur sie: der Pfad ist eine Konstante und kommt nie aus der Anfrage.
 * Suche und Filter laufen hier in Node über die gelesenen Zeilen und gehen in
 * kein Kommando.
 *
 * Ohne Filter liest ein Aufruf so viele Zeilen, wie er zeigt (höchstens 2000).
 * Mit Filter liest er ein festes Fenster (`FILTER_WINDOW`) und sagt, wie groß
 * es war. Die Seite pollt diese Route, deshalb ist beides eine feste Obergrenze
 * und kein Zeitraum.
 *
 * ── Ehrliche Nullwerte ──
 *
 * Eine leere Liste hieße „HAProxy hat nichts geschrieben". Das stimmt nur, wenn
 * die Datei da ist und der Mitschnitt läuft. Deshalb gehen `exists` und der
 * Zustand des Mitschnitts mit, und die Seite sagt, welcher Fall vorliegt.
 */

const READ_MS = 30_000;

export async function GET(request: Request) {
  try {
    await requireSession();

    const url = new URL(request.url);
    const limit = clampLines(url.searchParams.get('lines'));
    const filterParam = url.searchParams.get('filter') ?? 'all';
    const filter = isLogFilter(filterParam) ? filterParam : 'all';
    const query = (url.searchParams.get('q') ?? '').trim().slice(0, MAX_QUERY_CHARS);
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
      const missing: HaproxyLogView = {
        ...base,
        exists: false,
        size: null,
        modifiedAt: null,
        scanned: 0,
        matched: 0,
        entries: [],
      };
      return ok(missing);
    }

    const result = await sshExec(
      await getSSHConfig(localServer()),
      tailCommand(HAPROXY_LOG_FILE, window),
      READ_MS
    );
    if (result.code !== 0) {
      throw new ApiError(msg('Das HAProxy-Log konnte nicht gelesen werden.'), 500);
    }

    const all = parseLogOutput(result.stdout);
    const { entries, matched } = filterEntries(all, { filter, query, limit });

    const view: HaproxyLogView = {
      ...base,
      exists: true,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      scanned: all.length,
      matched,
      entries,
    };
    return ok(view);
  } catch (err) {
    return handleError(err);
  }
}
