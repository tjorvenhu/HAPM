import { requireSession } from '@/lib/session';
import { ok, handleError } from '@/lib/api';
import { listZoneRows } from '@/lib/dns/store';
import { providerOf } from '@/lib/dns/zones';

/**
 * Die Namen der angebundenen Zonen, aus der Datenbank und ohne den Anbieter zu
 * fragen. Für die Vorschläge im Domainfeld eines Ziels: `GET /api/dns/zones`
 * prüft dabei jeden Zugang beim Anbieter, und das dauert länger, als ein Feld
 * auf seine Vorschläge warten soll.
 */
export async function GET() {
  try {
    await requireSession();
    const zones = await listZoneRows();
    return ok({ zones: zones.map((zone) => ({ name: zone.name, provider: providerOf(zone) })) });
  } catch (err) {
    return handleError(err);
  }
}
