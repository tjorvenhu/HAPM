import { requireSession, requireCsrf } from '@/lib/session';
import { createDocument } from '@/lib/db';
import { COLLECTIONS, type DnsZone } from '@/lib/types';
import { encrypt } from '@/lib/crypto';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { logAudit, getClientIP } from '@/lib/audit';
import { findZone, listRecords, listZones } from '@/lib/dns/cloudflare';
import { forClient, listZoneRows, markZone, tokenOf, zoneExists } from '@/lib/dns/store';
import { normalizeDomain, validateZoneName } from '@/lib/dns/zones';

/**
 * Die verwalteten Domains.
 *
 * Die Zeilen kommen aus der Datenbank, die ZAHL der Einträge von Cloudflare —
 * eine Abfrage je Zone und Aufruf. Das ist derselbe Handel wie bei den
 * Reverse-Proxy-Zielen: die Wahrheit liegt beim Anbieter, und eine gespiegelte
 * Zahl wäre genau dann falsch, wenn jemand im Dashboard etwas angelegt hat.
 *
 * Scheitert eine Zone, fällt nicht die Liste aus: sie steht mit `records: null`
 * und ihrem Fehler daneben. `null` heißt unbekannt und nicht null Einträge —
 * eine beruhigende 0 an einer Zone, deren Token abgelaufen ist, wäre die
 * schlechtere Auskunft.
 */
export async function GET() {
  try {
    await requireSession();
    const zones = await listZoneRows();

    const rows = await Promise.all(
      zones.map(async (zone) => {
        try {
          const records = await listRecords(tokenOf(zone), zone.zoneId);
          await markZone(zone, null);
          return {
            ...forClient(zone),
            status: 'ok' as const,
            lastError: null,
            records: records.length,
          };
        } catch (err) {
          const error = err instanceof Error ? err.message : 'Unbekannter Fehler';
          await markZone(zone, error);
          return { ...forClient(zone), status: 'error' as const, lastError: error, records: null };
        }
      })
    );

    return ok(rows);
  } catch (err) {
    return handleError(err);
  }
}

interface CreateBody {
  name?: string;
  apiToken?: string;
}

/**
 * Eine Domain einrichten.
 *
 * Der Token wird nicht geglaubt, sondern benutzt: die Zone-ID kommt aus der
 * Antwort von Cloudflare und nicht aus dem Formular. Ohne diesen Schritt stünde
 * hier eine Zeile, die erst beim ersten echten Eintrag auffliegt — und das wäre
 * mitten in einem Proxy-Vorgang.
 *
 * Findet der Token die Zone nicht, nennt die Meldung die Zonen, die er sieht.
 * Der häufigste Fehler ist ein Token, der für eine andere Domain erzeugt wurde,
 * und „nicht gefunden" schickt einen dabei in die falsche Richtung.
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody<CreateBody>(request);

    const name = normalizeDomain(String(body.name ?? ''));
    const invalid = validateZoneName(name);
    if (invalid) throw new ApiError(invalid);

    const token = String(body.apiToken ?? '').trim();
    if (!token) throw new ApiError('Bitte den Cloudflare-API-Token angeben.');

    if (await zoneExists(name)) {
      throw new ApiError(`${name} ist hier bereits eingerichtet.`, 409);
    }

    const zone = await findZone(token, name);
    if (!zone) {
      const visible = await listZones(token).catch(() => []);
      const hint =
        visible.length > 0
          ? ` Der Token sieht: ${visible.slice(0, 8).map((z) => z.name).join(', ')}.`
          : ' Der Token sieht überhaupt keine Zone.';
      throw new ApiError(`Cloudflare kennt unter diesem Token keine Zone "${name}".${hint}`, 404);
    }

    const row = await createDocument<DnsZone>(COLLECTIONS.DNS_ZONES, {
      name: zone.name.toLowerCase(),
      zoneId: zone.id,
      apiToken: encrypt(token),
      // Der Token hat gerade funktioniert — das ist keine Annahme, sondern das
      // Ergebnis des Aufrufs zwei Zeilen darüber.
      status: 'ok',
      lastCheckedAt: new Date().toISOString(),
      lastError: null,
    });

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'dns_zone_created',
      resource: 'dns_zone',
      resourceId: row.$id,
      details: `${zone.name} eingerichtet (Zone ${zone.id})`,
      ip: getClientIP(request) ?? undefined,
    });

    // `status` ist bei Cloudflare `active`, solange die Nameserver dorthin
    // zeigen. Es geht mit zurück, damit der Dialog eine Zone, die dort nur
    // angelegt aber nicht delegiert ist, sofort benennen kann.
    return ok({ ...forClient(row), zoneStatus: zone.status });
  } catch (err) {
    return handleError(err);
  }
}
