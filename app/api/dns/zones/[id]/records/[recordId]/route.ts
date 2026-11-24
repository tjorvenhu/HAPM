import { requireSession, requireCsrf } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { logAudit, getClientIP } from '@/lib/audit';
import { providerFor, type DnsProvider, type ZoneRef } from '@/lib/dns/provider';
import { getZoneRow, withZone } from '@/lib/dns/store';
import { recordFqdn } from '@/lib/dns/zones';
import {
  isEditableRecord,
  readRecordInput,
  validateRecordInput,
  type DnsRecord,
} from '@/lib/dns/records';

interface Params {
  params: Promise<{ id: string; recordId: string }>;
}

/**
 * Den Eintrag holen, wie er JETZT dasteht.
 *
 * Nicht aus Vorsicht, sondern weil drei Dinge daran hängen: ob er überhaupt
 * angefasst werden darf (`isEditableRecord` — ein SRV oder ein vom Anbieter
 * gepflegter Eintrag nicht), was vorher dort stand, und womit der Anbieter ihn
 * wiederfindet. Nach dem Schreiben ist der alte Wert weg, und die
 * Protokollzeile ist dann die einzige Stelle, an der er noch steht.
 *
 * Bei Hetzner ist die Kennung aus Name, Art und Wert gebildet. Hat jemand den
 * Wert inzwischen in der Konsole geändert, gibt es den Eintrag unter dieser
 * Kennung nicht mehr, und genau das meldet der 404 hier.
 */
async function readCurrent(
  provider: DnsProvider,
  token: string,
  ref: ZoneRef,
  recordId: string
): Promise<DnsRecord> {
  const records = await provider.listRecords(token, ref);
  const record = records.find((r) => r.id === recordId);
  if (!record) throw new ApiError('Diesen Eintrag gibt es in der Zone nicht (mehr).', 404);
  if (!isEditableRecord(record)) {
    throw new ApiError(
      `Ein ${record.type}-Eintrag lässt sich hier nicht ändern. Er wird angezeigt und nicht angefasst.`,
      409
    );
  }
  return record;
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const { id, recordId } = await params;
    const zone = await getZoneRow(id);

    const provider = providerFor(zone);
    const input = readRecordInput(await jsonBody<Record<string, unknown>>(request), provider.id);
    const invalid = validateRecordInput(input, zone.name, provider.id);
    if (invalid) throw new ApiError(invalid);

    const fqdn = recordFqdn(input.name, zone.name);
    const { before, record } = await withZone(zone, async (token, ref) => {
      const current = await readCurrent(provider, token, ref, recordId);
      const written = await provider.updateRecord(token, ref, current, {
        type: input.type,
        name: fqdn,
        content: input.content,
        ttl: input.ttl,
        proxied: input.proxied,
        ...(input.priority === null ? {} : { priority: input.priority }),
        ...(input.comment === null ? {} : { comment: input.comment }),
      });
      return { before: current, record: written };
    });

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'dns_record_updated',
      resource: 'dns_zone',
      resourceId: zone.$id,
      details:
        `${before.type} ${before.name} → ${before.content}` +
        ` wurde zu ${input.type} ${fqdn} → ${input.content}`,
      ip: getClientIP(request) ?? undefined,
    });

    return ok(record);
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const { id, recordId } = await params;
    const zone = await getZoneRow(id);

    const provider = providerFor(zone);
    const before = await withZone(zone, async (token, ref) => {
      const current = await readCurrent(provider, token, ref, recordId);
      await provider.deleteRecord(token, ref, current);
      return current;
    });

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'dns_record_deleted',
      resource: 'dns_zone',
      resourceId: zone.$id,
      // Mit Wert: der Eintrag ist beim Anbieter weg, und diese Zeile ist die
      // einzige Stelle, an der noch steht, worauf er zeigte.
      details: `${before.type} ${before.name} → ${before.content} entfernt`,
      ip: getClientIP(request) ?? undefined,
    });

    return ok({ id: recordId });
  } catch (err) {
    return handleError(err);
  }
}
