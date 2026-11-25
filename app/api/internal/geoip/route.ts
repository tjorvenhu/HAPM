import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError, jsonBody } from '@/lib/api';
import { getClientIP, serviceActor } from '@/lib/audit';
import { geoipOverview } from '@/lib/geoip/fetch';
import { changeGeoipAutoRefresh } from '@/lib/geoip/actions';

/**
 * Die Länder-Tabelle (GeoIP) für die Länderverteilung der Statistik und die
 * Ländersperre: Stand, Herkunft, letzter Abruf. PATCH setzt den Schalter
 * `autoRefresh`. Upload und Zurücksetzen bleiben in der Oberfläche
 * (`lib/geoip/actions.ts`).
 */

export async function GET(request: Request) {
  try {
    await requireServiceToken(request);
    return ok(await geoipOverview());
  } catch (err) {
    return handleError(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const service = await requireServiceToken(request);
    const body = await jsonBody(request);
    return ok(await changeGeoipAutoRefresh(body.autoRefresh, { ...serviceActor(service), ip: getClientIP(request) }));
  } catch (err) {
    return handleError(err);
  }
}
