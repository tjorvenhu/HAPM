import { requireSession, requireCsrf } from '@/lib/session';
import { deleteDocument } from '@/lib/db';
import { COLLECTIONS } from '@/lib/types';
import { ok, handleError, jsonBody } from '@/lib/api';
import { logAudit, getClientIP } from '@/lib/audit';
import { replaceZoneToken } from '@/lib/dns/connect';
import { providerFor } from '@/lib/dns/provider';
import { dnsProviderLabel } from '@/lib/dns/provider-info';
import { forClient, getZoneRow, withZone } from '@/lib/dns/store';
import { providerOf } from '@/lib/dns/zones';

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * Eine Zone mit ihren Einträgen.
 *
 * Die Einträge kommen bei JEDEM Aufruf vom Anbieter. Es gibt keine Collection
 * dafür, und das ist dieselbe Entscheidung wie beim Reverse-Proxy: eine
 * Spiegelung wäre genau in dem Moment falsch, in dem jemand beim Anbieter etwas
 * geändert hat — also in dem Moment, in dem man sie am dringendsten braucht.
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    await requireSession();
    const { id } = await params;
    const zone = await getZoneRow(id);

    try {
      const records = await withZone(zone, (token, ref) =>
        providerFor(zone).listRecords(token, ref)
      );
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
 * gelesen (`replaceZoneToken`): ein Token für eine andere Domain käme sonst als
 * „gespeichert" zurück und schlüge erst beim nächsten Eintrag fehl. Der
 * Anbieter bleibt der der Zeile. Wer die Domain umgezogen hat, richtet sie
 * unter „Domain hinzufügen" beim neuen Anbieter ein.
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
 * Eine Domain aus der Verwaltung nehmen.
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
