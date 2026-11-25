import net from 'node:net';
import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { logAudit, getClientIP } from '@/lib/audit';
import { getSettings } from '@/lib/settings';
import { ensureAddressRecord } from '@/lib/dns/connect';
import { zoneForDomain } from '@/lib/dns/store';
import { normalizeSetupDomain, validateSetupDomain } from '@/lib/setup/rules';

/**
 * Der DNS-Eintrag der neuen Adresse, auf Bestätigung im Assistenten gesetzt.
 *
 * Nur bei einer Installation aus dem Internet und nur in einer Zone, die unter
 * „DNS" eingerichtet ist (`offerRecord`). Die Adresse kommt aus dem Formular:
 * hinter einer Adressumsetzung trägt der Server seine öffentliche Adresse
 * nicht selbst. Gesetzt wird über denselben Weg wie auf der Seite „DNS".
 */
export async function PUT(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody<{ domain?: unknown; address?: unknown }>(request);

    if ((await getSettings()).exposure !== 'public') {
      throw new ApiError(msg('Bei einer internen Installation gehört der Eintrag in den DNS-Server des eigenen Netzes.'));
    }

    const domain = normalizeSetupDomain(String(body.domain ?? ''));
    const invalid = validateSetupDomain(domain);
    if (invalid) throw new ApiError(invalid);

    const address = String(body.address ?? '').trim();
    if (net.isIP(address) === 0) {
      throw new ApiError(msg('Der Wert muss eine IPv4- oder IPv6-Adresse sein, etwa 192.0.2.10.'));
    }

    const zone = await zoneForDomain(domain);
    if (!zone) throw new ApiError(msg('{domain} liegt in keiner Zone, die unter DNS eingerichtet ist.', { domain }));

    const record = await ensureAddressRecord(zone.$id, { name: domain, address });
    if (record.outcome !== 'unchanged') {
      await logAudit({
        userId: session.userId,
        userEmail: session.email,
        action: record.outcome === 'created' ? 'dns_record_created' : 'dns_record_updated',
        resource: 'dns_zone',
        resourceId: zone.$id,
        details: `${record.type} ${domain} → ${address} (Umzug der Adresse)`,
        ip: getClientIP(request),
      });
    }

    return ok({ outcome: record.outcome, type: record.type, zone: zone.name });
  } catch (err) {
    return handleError(err);
  }
}
