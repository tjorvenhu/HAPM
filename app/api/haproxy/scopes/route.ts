import { requireSession, requireCsrf } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { getClientIP } from '@/lib/audit';
import { precheckScope } from '@/lib/haproxy/provision';
import { startHaproxyRun } from '@/lib/haproxy/runner';
import { getSettings } from '@/lib/settings';
import { validateScopeName, HaproxyConfigError } from '@/lib/haproxy/config';
import type { Server } from '@/lib/types';
import { localServer } from '@/lib/helpers';

/**
 * Die Gruppen des Reverse-Proxys: anlegen und entfernen.
 *
 * Eine Gruppe ist ein Marker-Paar in `haproxy.cfg`. Es gibt eine Datei, also
 * ist es ein Lauf. Die Antwort trägt `runs` trotzdem als Liste: so liest sie
 * die Seite, und so liefert sie auch `/api/internal/haproxy/scopes`.
 *
 * Vorabgeprüft wird synchron (`precheckScope`), bevor der Lauf startet. Sonst
 * endete ein Tippfehler im Namen als Zeile in der Historie, statt im Formular
 * zu stehen.
 */

function proxyServers(): Server[] {
  return [localServer()];
}

async function run(
  request: Request,
  name: string,
  action: 'scope-add' | 'scope-remove'
): Promise<Response> {
  const session = await requireSession();
  const servers = proxyServers();
  // Die Gruppe mit dem Ziel der Oberfläche bleibt stehen (`protected.ts`).
  const protection = { publicUrl: (await getSettings()).publicUrl };

  for (const server of servers) {
    try {
      if (action === 'scope-add') await precheckScope(server, name, 'add');
      else await precheckScope(server, name, 'remove', protection);
    } catch (err) {
      if (err instanceof HaproxyConfigError) {
        throw new ApiError(err, 409);
      }
      throw err;
    }
  }

  const actor = { userId: session.userId, email: session.email, ip: getClientIP(request) };
  const runs = [];
  for (const server of servers) {
    const started = await startHaproxyRun({ server, action, serviceId: name, protection, actor });
    runs.push({ runId: started.$id, serverName: server.name });
  }

  return ok({ runs });
}

export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const body = await jsonBody<{ name?: string }>(request);
    const name = String(body.name ?? '').trim();

    // Dieselbe Funktion wie im Formular, damit nicht zwei Regelwerke entstehen.
    const invalid = validateScopeName(name);
    if (invalid) throw new ApiError(invalid);

    return await run(request, name, 'scope-add');
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(request: Request) {
  try {
    await requireCsrf(request);
    const body = await jsonBody<{ name?: string }>(request);
    const name = String(body.name ?? '').trim();
    if (!name) throw new ApiError(msg('Es wurde keine Gruppe angegeben.'));

    return await run(request, name, 'scope-remove');
  } catch (err) {
    return handleError(err);
  }
}
