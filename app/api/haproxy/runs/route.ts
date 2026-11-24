import { requireSession } from '@/lib/session';
import { listDocuments, Query } from '@/lib/db';
import { COLLECTIONS } from '@/lib/types';
import { ok, handleError } from '@/lib/api';
import { parseSteps } from '@/lib/haproxy/runner';
import type { HaproxyRun, RunStatus, HaproxyAction } from '@/lib/types';

const STATUSES: RunStatus[] = ['running', 'success', 'warning', 'error', 'cancelled'];
/** Die Allow-Liste des `?action=`-Filters. Was hier fehlt, wird still ignoriert
 *  und liefert ungefiltert alles — deshalb gehört jede neue Art von Vorgang
 *  hier hinein, sonst zeigt der Filter etwas anderes an, als sein Wort sagt. */
const ACTIONS: HaproxyAction[] = [
  'create',
  'update',
  'delete',
  'settings',
  'scope-add',
  'scope-remove',
  'stream-create',
  'stream-update',
  'stream-delete',
];

/**
 * Die Historie des Reverse-Proxys, gefiltert und seitenweise.
 *
 * Die einzige, die es gibt: `haproxy.cfg` kennt nur ihren aktuellen Stand, und
 * eine Weiche, die gestern gelöscht wurde, steht dort naturgemäß nicht mehr.
 * Deshalb tragen die Zeilen Domains und Ziele mit, statt sie beim Anzeigen
 * nachzuschlagen — nachschlagen ließe sich genau das nicht mehr, worum es geht.
 *
 * Die Schritte kommen als Feld mit, nicht als String: die Seite zeigt sie
 * aufgeklappt, und ein zweiter Aufruf je Zeile wäre eine Anfrage pro Klick für
 * Daten, die schon da sind.
 */
export async function GET(request: Request) {
  try {
    await requireSession();
    const url = new URL(request.url);
    const serverId = url.searchParams.get('serverId');
    const status = url.searchParams.get('status');
    const action = url.searchParams.get('action');
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0);

    // `?source=api` — nur die Vorgänge, die über /api/internal/haproxy kamen.
    // Das ist der Filter der Seite „Reverse-Proxy → API": sie soll zeigen, ob
    // die Pipeline durchkommt, und nicht, was jemand nebenher im Dialog getan
    // hat. Gefiltert wird über `triggeredByTokenId` und nicht über den Namen —
    // ein Mensch und ein Token stehen beide mit ihrem Namen in `triggeredBy`.
    // Läufe von vor dieser Spalte tragen sie nicht und fehlen hier deshalb.
    const source = url.searchParams.get('source');

    const runs = await listDocuments<HaproxyRun>(COLLECTIONS.HAPROXY_RUNS, [
      ...(serverId ? [Query.equal('serverId', serverId)] : []),
      ...(source === 'api' ? [Query.isNotNull('triggeredByTokenId')] : []),
      ...(status && STATUSES.includes(status as RunStatus) ? [Query.equal('status', status)] : []),
      ...(action && ACTIONS.includes(action as HaproxyAction)
        ? [Query.equal('action', action)]
        : []),
      Query.orderDesc('startedAt'),
      Query.limit(limit),
      Query.offset(offset),
    ]);

    return ok(runs.map((run) => ({ ...run, steps: parseSteps(run.steps) })));
  } catch (err) {
    return handleError(err);
  }
}
