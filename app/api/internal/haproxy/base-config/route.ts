import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError, jsonBody } from '@/lib/api';
import { getT } from '@/lib/i18n/server';
import { getClientIP, serviceActor } from '@/lib/audit';
import { applyBaseConfig, readBaseConfigRows } from '@/lib/haproxy/maintenance-actions';

/**
 * Der Abgleich von `haproxy.cfg` mit der Grundkonfiguration, die HAPM heute
 * schriebe, wie unter „Reverse-Proxy → Einstellungen". GET liest ihn, POST
 * übernimmt ausgewählte Abweichungen (`{ "ids": [...] }` aus dem Abgleich).
 * Synchron: die Schritte (`haproxy -c`, Reload) stehen in der Antwort.
 */

export async function GET(request: Request) {
  try {
    await requireServiceToken(request);
    const { t, locale } = await getT();
    return ok(await readBaseConfigRows(t, locale));
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(request: Request) {
  try {
    const service = await requireServiceToken(request);
    const body = await jsonBody<{ serverId?: unknown; ids?: unknown }>(request);
    return ok(await applyBaseConfig(body, { ...serviceActor(service), ip: getClientIP(request) }));
  } catch (err) {
    return handleError(err);
  }
}
