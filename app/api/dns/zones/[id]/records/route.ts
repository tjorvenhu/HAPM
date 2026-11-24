import { requireSession, requireCsrf } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { logAudit, getClientIP } from '@/lib/audit';
import { providerFor } from '@/lib/dns/provider';
import { getZoneRow, withZone } from '@/lib/dns/store';
import { recordFqdn } from '@/lib/dns/zones';
import { readRecordInput, validateRecordInput } from '@/lib/dns/records';

interface Params {
  params: Promise<{ id: string }>;
}

/** Die Einträge einer Zone, live. Für Seiten, die nur die Liste brauchen. */
export async function GET(_request: Request, { params }: Params) {
  try {
    await requireSession();
    const { id } = await params;
    const zone = await getZoneRow(id);
    const records = await withZone(zone, (token, ref) =>
      providerFor(zone).listRecords(token, ref)
    );
    return ok(records);
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Einen Eintrag anlegen.
 *
 * Der Name kommt relativ zur Zone aus dem Formular (`app`, `@`, `*`) und geht
 * voll an den Anbieter. Die Umrechnung steht in `recordFqdn` und nicht hier:
 * das Formular zeigt denselben Namen an, den es schickt, und beides muss
 * dieselbe Funktion sein.
 *
 * Geprüft wird nach den Regeln des Anbieters der Zone (`PROVIDER_RULES`).
 */
export async function POST(request: Request, { params }: Params) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const { id } = await params;
    const zone = await getZoneRow(id);

    const provider = providerFor(zone);
    const input = readRecordInput(await jsonBody<Record<string, unknown>>(request), provider.id);
    const invalid = validateRecordInput(input, zone.name, provider.id);
    if (invalid) throw new ApiError(invalid);

    const fqdn = recordFqdn(input.name, zone.name);
    const record = await withZone(zone, (token, ref) =>
      provider.createRecord(token, ref, {
        type: input.type,
        name: fqdn,
        content: input.content,
        ttl: input.ttl,
        proxied: input.proxied,
        ...(input.priority === null ? {} : { priority: input.priority }),
        ...(input.comment === null ? {} : { comment: input.comment }),
      })
    );

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'dns_record_created',
      resource: 'dns_zone',
      resourceId: zone.$id,
      details: `${input.type} ${fqdn} → ${input.content}`,
      ip: getClientIP(request) ?? undefined,
    });

    return ok(record);
  } catch (err) {
    return handleError(err);
  }
}
