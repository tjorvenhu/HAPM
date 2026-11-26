import { requireSession, requireCsrf } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { getLocale } from '@/lib/i18n/server';
import { logAudit, getClientIP } from '@/lib/audit';
import { connectZone } from '@/lib/dns/connect';
import { accessFromInput, dnsProviderLabel } from '@/lib/dns/provider-info';
import { checkZones } from '@/lib/dns/zone-check';
import { isDnsProviderId, normalizeDomain, validateZoneName } from '@/lib/dns/zones';

/**
 * Die angebundenen Domains, und ob ihr Zugang gerade funktioniert. Die Prüfung
 * je Zone steht in `lib/dns/zone-check.ts`, der MCP-Server ruft sie auch.
 */
export async function GET() {
  try {
    await requireSession();
    return ok(await checkZones(await getLocale()));
  } catch (err) {
    return handleError(err);
  }
}

interface CreateBody {
  provider?: string;
  name?: string;
  /** Cloudflare und Hetzner: der API-Token. */
  apiToken?: string;
  /** RFC 2136 und Infoblox: die Felder des Anbieters nach Namen. */
  values?: Record<string, unknown>;
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

    const input = accessFromInput(provider, { token: body.apiToken, values: body.values });
    if ('error' in input) throw new ApiError(input.error);

    const { zone, created, delegated } = await connectZone({ provider, domain: name, token: input.access });

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: created ? 'dns_zone_created' : 'dns_zone_updated',
      resource: 'dns_zone',
      resourceId: zone.$id,
      // Der Zugang steht nie im Protokoll, auch nicht gekürzt.
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
