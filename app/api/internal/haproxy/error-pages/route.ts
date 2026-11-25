import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError } from '@/lib/api';
import { getT } from '@/lib/i18n/server';
import { getClientIP, serviceActor } from '@/lib/audit';
import { readErrorPageRows, redeployErrorPages } from '@/lib/haproxy/maintenance-actions';

/**
 * Die Fehlerseiten von HAProxy: welche Dateien `haproxy.cfg` nennt und ob sie
 * dem gespeicherten Design entsprechen. POST schreibt sie neu, im
 * gespeicherten Design, mit `haproxy -c` und Reload. Das Design selbst ändert
 * nur die Oberfläche.
 */

export async function GET(request: Request) {
  try {
    await requireServiceToken(request);
    const { t, locale } = await getT();
    return ok(await readErrorPageRows(t, locale));
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(request: Request) {
  try {
    const service = await requireServiceToken(request);
    return ok(await redeployErrorPages({}, { ...serviceActor(service), ip: getClientIP(request) }));
  } catch (err) {
    return handleError(err);
  }
}
