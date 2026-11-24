import { requireSession, requireCsrf } from '@/lib/session';
import { deleteDocument } from '@/lib/db';
import { COLLECTIONS } from '@/lib/types';
import { ok, handleError, jsonBody } from '@/lib/api';
import { logAudit, getClientIP } from '@/lib/audit';
import { replaceZoneToken } from '@/lib/dns/connect';
import { dnsProviderLabel } from '@/lib/dns/provider-info';
import { getZoneRow } from '@/lib/dns/store';
import { providerOf } from '@/lib/dns/zones';

interface Params {
  params: Promise<{ id: string }>;
}

interface PatchBody {
  apiToken?: string;
}

/**
 * Den Token austauschen.
 *
 * Der Name der Zone lässt sich nicht ändern: er steht in jedem Suffixvergleich,
 * der eine Domain einer Zone zuordnet. Eine andere Domain ist eine andere
 * Zone, dafür gibt es Anbinden und Entfernen.
 *
 * Geprüft wird gegen den gespeicherten Namen, und die Zone-ID wird dabei neu
 * gelesen (`replaceZoneToken`): ein Token für eine andere Domain käme sonst als
 * „gespeichert" zurück und schlüge erst beim nächsten Eintrag fehl. Der
 * Anbieter bleibt der der Zeile. Wer die Domain umgezogen hat, richtet sie
 * unter „Domain anbinden" beim neuen Anbieter ein.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const { id } = await params;
    const body = await jsonBody<PatchBody>(request);

    const updated = await replaceZoneToken(id, String(body.apiToken ?? ''));

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'dns_zone_updated',
      resource: 'dns_zone',
      resourceId: id,
      // Der Token steht nie im Protokoll, auch nicht gekürzt.
      details: `API-Token für ${updated.name} ausgetauscht`,
      ip: getClientIP(request) ?? undefined,
    });

    return ok(updated);
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Die Anbindung einer Domain entfernen.
 *
 * Beim Anbieter passiert dabei nichts: die Einträge bleiben, die Zone bleibt,
 * nur der Zugang von hier ist weg. Alles andere wäre ein Löschknopf, der eine
 * ganze Domain offline nimmt, während er aussieht wie „aus der Liste entfernen".
 * Der Bestätigungsdialog sagt genau das.
 */
export async function DELETE(request: Request, { params }: Params) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const { id } = await params;
    const zone = await getZoneRow(id);

    await deleteDocument(COLLECTIONS.DNS_ZONES, id);

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'dns_zone_deleted',
      resource: 'dns_zone',
      resourceId: id,
      details: `${zone.name} aus der Verwaltung genommen. Bei ${dnsProviderLabel(providerOf(zone))} wurde nichts geändert.`,
      ip: getClientIP(request) ?? undefined,
    });

    return ok({ id });
  } catch (err) {
    return handleError(err);
  }
}
