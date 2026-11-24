import { requireSession, requireCsrf } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { logAudit, getClientIP } from '@/lib/audit';
import { connectZone } from '@/lib/dns/connect';
import { providerFor } from '@/lib/dns/provider';
import { dnsProviderLabel } from '@/lib/dns/provider-info';
import { forClient, listZoneRows, withZone } from '@/lib/dns/store';
import { isDnsProviderId, normalizeDomain, validateZoneName } from '@/lib/dns/zones';

/**
 * Die verwalteten Domains.
 *
 * Die Zeilen kommen aus der Datenbank, die ZAHL der Einträge vom Anbieter —
 * eine Abfrage je Zone und Aufruf (bei Hetzner eine je 50 Namen). Das ist derselbe Handel wie bei den
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
          const records = await withZone(zone, (token, ref) =>
            providerFor(zone).listRecords(token, ref)
          );
          return {
            ...forClient(zone),
            status: 'ok' as const,
            lastError: null,
            records: records.length,
          };
        } catch (err) {
          const error = err instanceof Error ? err.message : 'Unbekannter Fehler';
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
  provider?: string;
  name?: string;
  apiToken?: string;
}

/**
 * Eine Domain einrichten.
 *
 * Der Weg ist `connectZone` (`lib/dns/connect.ts`), derselbe wie im
 * Einrichtungsassistenten: der Token wird benutzt und nicht geglaubt, gesucht
 * wird die Zone, in der die Domain liegt, und eine schon eingerichtete Zone
 * bekommt den neuen Zugang statt einer zweiten Zeile. Hier bleibt, was zur
 * Route gehört: die Eingabe prüfen und den Vorgang protokollieren.
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody<CreateBody>(request);

    const name = normalizeDomain(String(body.name ?? ''));
    const invalid = validateZoneName(name);
    if (invalid) throw new ApiError(invalid);

    if (!isDnsProviderId(body.provider)) throw new ApiError('Bitte den Anbieter wählen.');
    const provider = body.provider;

    const { zone, created, delegated } = await connectZone({
      provider,
      domain: name,
      token: String(body.apiToken ?? ''),
    });

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: created ? 'dns_zone_created' : 'dns_zone_updated',
      resource: 'dns_zone',
      resourceId: zone.$id,
      // Der Token steht nie im Protokoll, auch nicht gekürzt.
      details: created
        ? `${zone.name} bei ${dnsProviderLabel(provider)} eingerichtet (Zone ${zone.zoneId})`
        : `Zugang zu ${zone.name} ersetzt (${dnsProviderLabel(provider)}, Zone ${zone.zoneId})`,
      ip: getClientIP(request) ?? undefined,
    });

    // `created` und `delegated` gehen mit zurück, damit die Seite sagen kann,
    // was passiert ist: eine Zone, die schon dastand, und eine, deren
    // Nameserver noch nicht auf den Anbieter zeigen, sind beide kein Fehler,
    // aber auch nicht das, was „hinzugefügt" verspricht.
    return ok({ ...zone, created, delegated });
  } catch (err) {
    return handleError(err);
  }
}
