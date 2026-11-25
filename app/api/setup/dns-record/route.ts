import net from 'node:net';
import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { logAudit, getClientIP } from '@/lib/audit';
import { connectZone, ensureAddressRecord } from '@/lib/dns/connect';
import { dnsProviderForHook } from '@/lib/dns/zones';
import { readSetupView } from '@/lib/setup';
import { normalizeSetupDomain, validateSetupDomain } from '@/lib/setup/rules';
import { getDnsAccess, getSetupState } from '@/lib/setup/store';

/**
 * Schritt 6 der Einrichtung, der Knopf „Eintrag anlegen": setzt den DNS-Eintrag
 * der Oberfläche beim gewählten Anbieter.
 *
 * Das Token dafür liegt seit Schritt 3 verschlüsselt beim Assistenten
 * (`SetupState.dnsAccess`). Mit der Domain steht jetzt die Zone fest: sie wird
 * unter „DNS" eingerichtet (dort liegt das Token danach wie bei jeder Zone),
 * und der Eintrag entsteht über denselben Weg wie dort.
 *
 * Die Adresse kommt aus dem Formular und nicht vom Server: hinter einer
 * Adressumsetzung trägt der Server seine öffentliche Adresse nicht selbst.
 */
export async function PUT(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody<{ domain?: unknown; address?: unknown }>(request);

    const state = await getSetupState();
    if (!state.exposure) throw new ApiError(msg('Bitte wählen Sie zuerst die Erreichbarkeit.'));

    const domain = normalizeSetupDomain(String(body.domain ?? ''));
    const invalid = validateSetupDomain(domain);
    if (invalid) throw new ApiError(invalid);

    const address = String(body.address ?? '').trim();
    if (net.isIP(address) === 0) {
      throw new ApiError(msg('Der Wert muss eine IPv4- oder IPv6-Adresse sein, etwa 192.0.2.10.'));
    }

    const access = await getDnsAccess();
    const provider = access ? dnsProviderForHook(access.hook) : null;
    if (!access || !provider || access.hook !== state.dnsHook) {
      throw new ApiError(
        msg(
          'Für diesen Schritt fehlt das Token des DNS-Anbieters. Tragen Sie es im Schritt davor noch einmal ein, oder legen Sie den Eintrag selbst an.'
        )
      );
    }

    const { zone, created, delegated } = await connectZone({ provider, domain, token: access.token });
    const record = await ensureAddressRecord(zone.$id, { name: domain, address });

    if (created) {
      await logAudit({
        userId: session.userId,
        userEmail: session.email,
        action: 'dns_zone_created',
        resource: 'dns_zone',
        resourceId: zone.$id,
        details: `${zone.name} (Einrichtung)`,
        ip: getClientIP(request),
      });
    }
    if (record.outcome !== 'unchanged') {
      await logAudit({
        userId: session.userId,
        userEmail: session.email,
        action: record.outcome === 'created' ? 'dns_record_created' : 'dns_record_updated',
        resource: 'dns_zone',
        resourceId: zone.$id,
        details: `${record.type} ${domain} → ${address} (Einrichtung)`,
        ip: getClientIP(request),
      });
    }

    return ok({
      outcome: record.outcome,
      type: record.type,
      zone: zone.name,
      zoneCreated: created,
      // `false`: die Nameserver der Domain zeigen nicht auf diesen Anbieter.
      delegated,
      setup: await readSetupView(),
    });
  } catch (err) {
    return handleError(err);
  }
}
