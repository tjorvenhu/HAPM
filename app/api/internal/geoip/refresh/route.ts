import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError } from '@/lib/api';
import { getClientIP, serviceActor } from '@/lib/audit';
import { refreshGeoipNow } from '@/lib/geoip/actions';

/**
 * Die Länder-Tabelle jetzt von db-ip.com holen. Wartet, bis der Abruf durch
 * ist (Sekunden). `502`, wenn die Gegenseite nicht geliefert hat.
 */
export async function POST(request: Request) {
  try {
    const service = await requireServiceToken(request);
    return ok(await refreshGeoipNow({ ...serviceActor(service), ip: getClientIP(request) }));
  } catch (err) {
    return handleError(err);
  }
}
