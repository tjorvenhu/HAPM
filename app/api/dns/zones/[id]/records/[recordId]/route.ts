import { requireSession, requireCsrf } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { logAudit, getClientIP } from '@/lib/audit';
import { deleteRecord, listRecords, updateRecord } from '@/lib/dns/cloudflare';
import { getZoneRow, withZone } from '@/lib/dns/store';
import { recordFqdn } from '@/lib/dns/zones';
import {
  isEditableRecord,
  readRecordInput,
  validateRecordInput,
  TTL_AUTO,
  type DnsRecord,
} from '@/lib/dns/records';

interface Params {
  params: Promise<{ id: string; recordId: string }>;
}

/**
 * Den Eintrag holen, wie er JETZT dasteht.
 *
 * Nicht aus Vorsicht, sondern weil zwei Dinge daran hängen: ob er überhaupt
 * angefasst werden darf (`isEditableRecord` — ein SRV oder ein von Cloudflare
 * gepflegter Eintrag nicht), und was vorher dort stand. Nach dem Schreiben ist
 * der alte Wert weg, und die Protokollzeile ist dann die einzige Stelle, an der
 * er noch steht.
 */
async function readCurrent(
  token: string,
  zoneId: string,
  recordId: string
): Promise<DnsRecord> {
  const records = await listRecords(token, zoneId);
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

    const input = readRecordInput(await jsonBody<Record<string, unknown>>(request));
    const invalid = validateRecordInput(input, zone.name);
    if (invalid) throw new ApiError(invalid);

    const fqdn = recordFqdn(input.name, zone.name);
    const { before, record } = await withZone(zone, async (token, zoneId) => {
      const current = await readCurrent(token, zoneId, recordId);
      const written = await updateRecord(token, zoneId, recordId, {
        type: input.type,
        name: fqdn,
        content: input.content,
        ttl: input.ttl ?? TTL_AUTO,
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

    const before = await withZone(zone, async (token, zoneId) => {
      const current = await readCurrent(token, zoneId, recordId);
      await deleteRecord(token, zoneId, recordId);
      return current;
    });

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'dns_record_deleted',
      resource: 'dns_zone',
      resourceId: zone.$id,
      // Mit Wert: der Eintrag ist bei Cloudflare weg, und diese Zeile ist die
      // einzige Stelle, an der noch steht, worauf er zeigte.
      details: `${before.type} ${before.name} → ${before.content} entfernt`,
      ip: getClientIP(request) ?? undefined,
    });

    return ok({ id: recordId });
  } catch (err) {
    return handleError(err);
  }
}
