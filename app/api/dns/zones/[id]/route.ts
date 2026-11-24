import { requireSession, requireCsrf } from '@/lib/session';
import { updateDocument, deleteDocument } from '@/lib/db';
import { COLLECTIONS, type DnsZone } from '@/lib/types';
import { encrypt } from '@/lib/crypto';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { logAudit, getClientIP } from '@/lib/audit';
import { findZone, listRecords } from '@/lib/dns/cloudflare';
import { forClient, getZoneRow, withZone } from '@/lib/dns/store';

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * Eine Zone mit ihren Einträgen.
 *
 * Die Einträge kommen bei JEDEM Aufruf von Cloudflare. Es gibt keine Collection
 * dafür, und das ist dieselbe Entscheidung wie beim Reverse-Proxy: eine
 * Spiegelung wäre genau in dem Moment falsch, in dem jemand im Dashboard etwas
 * geändert hat — also in dem Moment, in dem man sie am dringendsten braucht.
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    await requireSession();
    const { id } = await params;
    const zone = await getZoneRow(id);

    try {
      const records = await withZone(zone, (token, zoneId) => listRecords(token, zoneId));
      return ok({ zone: { ...forClient(zone), status: 'ok' as const, lastError: null }, records });
    } catch (err) {
      // Die Seite soll trotzdem etwas zeigen können: den Namen der Zone und den
      // Grund, warum die Liste leer ist. Ein 502 hier wäre eine weiße Seite mit
      // einer Meldung, die nicht sagt, um welche Domain es geht.
      const error = err instanceof Error ? err.message : 'Unbekannter Fehler';
      return ok({
        zone: { ...forClient(zone), status: 'error' as const, lastError: error },
        records: [],
      });
    }
  } catch (err) {
    return handleError(err);
  }
}

interface PatchBody {
  apiToken?: string;
}

/**
 * Den Token austauschen.
 *
 * Der Name der Zone lässt sich nicht ändern: er steht in jedem Suffixvergleich,
 * der eine Domain einer Zone zuordnet, und in der Adresse der Seite. Eine andere
 * Domain ist eine andere Zone — dafür gibt es Anlegen und Entfernen.
 *
 * Geprüft wird gegen den gespeicherten Namen, und die Zone-ID wird dabei neu
 * gelesen: ein Token für eine andere Domain käme sonst als „gespeichert" zurück
 * und schlüge erst beim nächsten Eintrag fehl.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const { id } = await params;
    const zone = await getZoneRow(id);
    const body = await jsonBody<PatchBody>(request);

    const token = String(body.apiToken ?? '').trim();
    if (!token) throw new ApiError('Bitte den Cloudflare-API-Token angeben.');

    const found = await findZone(token, zone.name);
    if (!found) {
      throw new ApiError(`Dieser Token sieht die Zone "${zone.name}" nicht.`, 404);
    }

    const updated = await updateDocument<DnsZone>(COLLECTIONS.DNS_ZONES, id, {
      apiToken: encrypt(token),
      zoneId: found.id,
      status: 'ok',
      lastCheckedAt: new Date().toISOString(),
      lastError: null,
    });

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'dns_zone_updated',
      resource: 'dns_zone',
      resourceId: id,
      // Der Token steht nie im Protokoll, auch nicht gekürzt.
      details: `API-Token für ${zone.name} ausgetauscht`,
      ip: getClientIP(request) ?? undefined,
    });

    return ok(forClient(updated));
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Eine Domain aus der Verwaltung nehmen.
 *
 * Bei Cloudflare passiert dabei nichts: die Einträge bleiben, die Zone bleibt,
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
      details: `${zone.name} aus der Verwaltung genommen. Bei Cloudflare wurde nichts geändert.`,
      ip: getClientIP(request) ?? undefined,
    });

    return ok({ id });
  } catch (err) {
    return handleError(err);
  }
}
