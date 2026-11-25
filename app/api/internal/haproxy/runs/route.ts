import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError } from '@/lib/api';
import { listRuns } from '@/lib/haproxy/api-actions';

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
 * demselben Grund wie auf der Seite „Reverse-Proxy → API und MCP": ein Mensch und ein
 * Token stehen beide mit ihrem Namen in `triggeredBy`.
 *
 * Ohne Audit-Eintrag, wie `runs/<id>`: gelesen wird die eigene Historie, und
 * ein Aufrufer, der pollt, schriebe sonst mehr Protokollzeilen als der Vorgang
 * selbst. Die Logik steht in `lib/haproxy/api-actions.ts`.
 */
export async function GET(request: Request) {
  try {
    await requireServiceToken(request);

    const url = new URL(request.url);
    return ok(
      await listRuns({
        serverId: url.searchParams.get('serverId'),
        serviceId: url.searchParams.get('serviceId'),
        status: url.searchParams.get('status'),
        action: url.searchParams.get('action'),
        mine: url.searchParams.get('mine') === 'true',
        limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : null,
        offset: url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : null,
      })
    );
  } catch (err) {
    return handleError(err);
  }
}
