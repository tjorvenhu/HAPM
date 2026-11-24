import { requireSession, requireCsrf } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { getLocale } from '@/lib/i18n/server';
import { logAudit, getClientIP } from '@/lib/audit';
import { connectZone } from '@/lib/dns/connect';
import { providerFor } from '@/lib/dns/provider';
import { dnsProviderLabel } from '@/lib/dns/provider-info';
import { forClient, listZoneRows, withZone, zoneErrorText } from '@/lib/dns/store';
import { isDnsProviderId, normalizeDomain, validateZoneName } from '@/lib/dns/zones';

/**
 * Die angebundenen Domains, und ob ihr Zugang gerade funktioniert.
 *
 * Die Zeilen kommen aus der Datenbank, die Prüfung vom Anbieter: je Zone und
 * Aufruf fragt HAPM mit dem Token, welche Zonen er sieht. Steht die Zone
 * darunter, funktioniert der Zugang, und der Anbieter sagt dabei, ob die
 * Nameserver auf ihn zeigen (`delegated`, `null` heißt unbekannt). Ein
 * gespeicherter Zustand wäre genau dann falsch, wenn der Token beim Anbieter
 * zurückgezogen wurde.
 *
 * Scheitert eine Zone, fällt nicht die Liste aus: sie steht mit ihrem Fehler
 * daneben.
 */
export async function GET() {
  try {
    await requireSession();
    const zones = await listZoneRows();
    const locale = await getLocale();

    const rows = await Promise.all(
      zones.map(async (zone) => {
        const lastCheckedAt = new Date().toISOString();
        try {
          const found = await withZone(zone, async (token) => {
            const visible = await providerFor(zone).listZones(token);
            const match = visible.find((seen) => normalizeDomain(seen.name) === normalizeDomain(zone.name));
            if (!match) throw new ApiError(msg('Der Token sieht diese Zone nicht mehr.'), 404);
            return match;
          });
          return {
            ...forClient(zone),
            status: 'ok' as const,
            lastCheckedAt,
            lastError: null,
            delegated: found.delegated,
          };
        } catch (err) {
          return {
            ...forClient(zone),
            status: 'error' as const,
            lastCheckedAt,
            lastError: zoneErrorText(err, locale),
            delegated: null,
          };
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

    if (!isDnsProviderId(body.provider)) throw new ApiError(msg('Bitte den Anbieter wählen.'));
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
