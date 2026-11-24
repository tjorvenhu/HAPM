import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { serviceActor } from '@/lib/audit';
import { precheckScope } from '@/lib/haproxy/provision';
import { startHaproxyRun } from '@/lib/haproxy/runner';
import { getSettings } from '@/lib/settings';
import { haproxyActor, proxyServers, proxyView } from '@/lib/haproxy/internal';
import { HaproxyConfigError, validateScopeName } from '@/lib/haproxy/config';
import type { HaproxyActor } from '@/lib/haproxy/runner';

/**
 * Die Gruppen des Reverse-Proxys: die Marker-Paare, in denen die Einträge
 * stehen. `scope` ist beim Anlegen eines Ziels Pflicht, und welche es gibt,
 * sagt `haproxy.cfg` und nicht eine Liste im Code.
 *
 * Anlegen und Entfernen ist je ein Lauf. Die Antwort trägt `runs` trotzdem als
 * Liste, und die Route nimmt kein `serverId`.
 *
 * Vorabgeprüft wird, BEVOR der Lauf startet. Sonst endete ein Tippfehler als
 * Zeile in der Historie, statt dem Aufrufer zurückgegeben zu werden.
 */

/** Welche Gruppen es gibt. Eine Liste mit einem Eintrag, wie `/proxies`. */
export async function GET(request: Request) {
  try {
    await requireServiceToken(request);

    const servers = await proxyServers();
    const rows = await Promise.all(servers.map(proxyView));

    return ok(
      rows.map((row) => ({
        serverId: row.id,
        serverName: row.name,
        scopes: row.scopes,
        error: row.error,
      }))
    );
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Der gemeinsame Teil von Anlegen und Entfernen. Der Rumpf ist zu diesem
 * Zeitpunkt bereits gelesen — `request.json()` gibt es genau einmal, ein
 * zweiter Aufruf hier hätte jeden POST mit „Ungültiger Request-Body" beendet.
 */
async function applyToAll(
  name: string,
  action: 'scope-add' | 'scope-remove',
  actor: HaproxyActor
): Promise<Response> {
  const servers = await proxyServers();
  // Die Gruppe mit dem Ziel der Oberfläche bleibt stehen (`protected.ts`).
  const protection = { publicUrl: (await getSettings()).publicUrl };

  for (const server of servers) {
    try {
      if (action === 'scope-add') await precheckScope(server, name, 'add');
      else await precheckScope(server, name, 'remove', protection);
    } catch (err) {
      if (err instanceof HaproxyConfigError) {
        throw new ApiError(err.message, 409);
      }
      throw err;
    }
  }

  const runs = [];
  for (const server of servers) {
    const started = await startHaproxyRun({ server, action, serviceId: name, protection, actor });
    runs.push({ runId: started.$id, serverId: server.$id, serverName: server.name });
  }

  return ok({ name, runs });
}

export async function POST(request: Request) {
  try {
    const service = await requireServiceToken(request);
    const body = await jsonBody<{ name?: string }>(request);
    const name = String(body.name ?? '').trim();

    // Dieselbe Funktion wie im Formular, damit nicht zwei Regelwerke entstehen.
    const invalid = validateScopeName(name);
    if (invalid) throw new ApiError(invalid);

    return await applyToAll(name, 'scope-add', haproxyActor(serviceActor(service), request));
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Eine Gruppe entfernen. Sie muss leer sein — geprüft wird das im Lauf noch
 * einmal, denn zwischen Anzeige und Vorgang kann jemand etwas angelegt haben.
 */
export async function DELETE(request: Request) {
  try {
    const service = await requireServiceToken(request);
    const body = await jsonBody<{ name?: string }>(request);
    const name = String(body.name ?? '').trim();
    if (!name) throw new ApiError('Es wurde keine Gruppe angegeben.');

    return await applyToAll(name, 'scope-remove', haproxyActor(serviceActor(service), request));
  } catch (err) {
    return handleError(err);
  }
}
