import { requireServiceToken } from '@/lib/service-auth';
import { listDocuments, Query } from '@/lib/db';
import { COLLECTIONS } from '@/lib/types';
import { ok, handleError } from '@/lib/api';
import { parseSteps } from '@/lib/haproxy/runner';
import type { HaproxyRun, RunStatus, HaproxyAction } from '@/lib/types';

/**
 * Die Historie des Reverse-Proxys für einen anderen Dienst.
 *
 * `runs/<id>` allein reicht, solange eine Pipeline ihre eigene Lauf-ID
 * festhält. Verliert sie die — ein Neustart zwischen POST und Poll, ein Job,
 * der aus einer Warteschlange neu aufgesetzt wird —, gäbe es ohne diese Liste
 * keinen Weg zurück zu der Frage „ist das eigentlich durchgelaufen". Deshalb
 * `?serviceId=`: der Name des Eintrags ist das, was der Aufrufer selbst
 * vergeben hat und immer noch weiß.
 *
 * **`?mine=true` grenzt auf die Vorgänge über diese Schnittstelle ein.**
 * Gefiltert wird über `triggeredByTokenId` und nicht über den Namen, aus
 * demselben Grund wie auf der Seite „Reverse-Proxy → API": ein Mensch und ein
 * Token stehen beide mit ihrem Namen in `triggeredBy`.
 *
 * Ohne Audit-Eintrag, wie `runs/<id>`: gelesen wird die eigene Historie, und
 * ein Aufrufer, der pollt, schriebe sonst mehr Protokollzeilen als der Vorgang
 * selbst.
 */

const STATUSES: RunStatus[] = ['running', 'success', 'warning', 'error', 'cancelled'];

/** Dieselbe Allow-Liste wie im Sitzungs-Weg. Was hier fehlt, wird still
 *  ignoriert und liefert ungefiltert alles. */
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
  'certificate',
];

export async function GET(request: Request) {
  try {
    await requireServiceToken(request);

    const url = new URL(request.url);
    const serverId = url.searchParams.get('serverId');
    const serviceId = url.searchParams.get('serviceId');
    const status = url.searchParams.get('status');
    const action = url.searchParams.get('action');
    const mine = url.searchParams.get('mine') === 'true';
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 25) || 25, 1), 100);
    const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0);

    const runs = await listDocuments<HaproxyRun>(COLLECTIONS.HAPROXY_RUNS, [
      ...(serverId ? [Query.equal('serverId', serverId)] : []),
      // Auch die Kennung einer TCP-Weiterleitung steht in dieser Spalte: sie
      // ist die Kennung des Vorgangs und nicht die eines Dienstes.
      ...(serviceId ? [Query.equal('serviceId', serviceId)] : []),
      ...(mine ? [Query.isNotNull('triggeredByTokenId')] : []),
      ...(status && STATUSES.includes(status as RunStatus) ? [Query.equal('status', status)] : []),
      ...(action && ACTIONS.includes(action as HaproxyAction)
        ? [Query.equal('action', action)]
        : []),
      Query.orderDesc('startedAt'),
      Query.limit(limit),
      Query.offset(offset),
    ]);

    return ok(
      runs.map((run) => ({
        id: run.$id,
        serverId: run.serverId,
        serverName: run.serverName,
        action: run.action,
        serviceId: run.serviceId,
        renamedTo: run.renamedTo,
        // Bei einer TCP-Weiterleitung steht hier der Port statt der Domains,
        // siehe `describe` in lib/haproxy/runner.ts.
        domains: run.domains,
        targets: run.targets,
        status: run.status,
        phase: run.phase,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        duration: run.duration,
        error: run.error,
        steps: parseSteps(run.steps),
        triggeredBy: run.triggeredBy,
      }))
    );
  } catch (err) {
    return handleError(err);
  }
}
