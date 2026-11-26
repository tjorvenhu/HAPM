import { assertSetupOpen } from '@/lib/setup/run';
import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { logAudit, getClientIP } from '@/lib/audit';
import { getSettings, updateSettings } from '@/lib/settings';
import { readSetupView } from '@/lib/setup';
import { checkDomainAddress } from '@/lib/setup/address';
import {
  certificateFactsOf,
  isPublicAddress,
  normalizeSetupDomain,
  normalizeSurfaceIps,
  validateSetupDomain,
  validateSurfaceIps,
  validateWildcardBase,
  wildcardPossible,
} from '@/lib/setup/rules';
import { addressInNetwork } from '@/lib/geoip/networks';
import { getDnsAccess, getSetupState, setDnsAccess, updateSetupState } from '@/lib/setup/store';
import { connectZone } from '@/lib/dns/connect';
import { dnsProviderForHook } from '@/lib/dns/zones';

/**
 * Schritt 6 der Einrichtung: die Domain, unter der die Oberfläche stehen soll.
 *
 * GET fragt das DNS, worauf die Domain zeigt, und sagt, ob das eine Adresse
 * dieses Servers ist. Das Ergebnis hält niemanden auf: bei einer internen
 * Installation löst die Domain von außen oft gar nicht auf, und hinter einer
 * Adressumsetzung trägt der Server seine öffentliche Adresse nicht selbst.
 */
export async function GET(request: Request) {
  try {
    await requireSession();
    const domain = normalizeSetupDomain(new URL(request.url).searchParams.get('domain') ?? '');
    const invalid = validateSetupDomain(domain);
    if (invalid) throw new ApiError(invalid);
    return ok(await checkDomainAddress(domain, (await getSetupState()).exposure));
  } catch (err) {
    return handleError(err);
  }
}

export async function PUT(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    await assertSetupOpen();
    const body = await jsonBody<{
      domain?: unknown;
      wildcard?: unknown;
      wildcardBase?: unknown;
      surfaceIps?: unknown;
      skip?: unknown;
    }>(request);

    const state = await getSetupState();
    if (!state.exposure) throw new ApiError(msg('Bitte wählen Sie zuerst die Erreichbarkeit.'));

    if (body.skip === true) {
      if (state.exposure === 'internal') {
        throw new ApiError(msg('Eine interne Installation braucht die Adresse der Oberfläche.'));
      }
      await updateSetupState({
        address: 'skipped',
        domain: null,
        wildcard: false,
        wildcardBase: null,
        surfaceIps: [],
        execution: null,
      });
      // Ohne Adresse gibt es nichts auszuführen: die Einrichtung ist damit zu Ende.
      await updateSettings({ setupStatus: 'done' });
      await setDnsAccess(null);
      await logAudit({
        userId: session.userId,
        userEmail: session.email,
        action: 'setup_finished',
        resource: 'settings',
        details: 'Ohne Adresse der Oberfläche',
        ip: getClientIP(request),
      });
      return ok({ setup: await readSetupView(), check: null });
    }

    const domain = normalizeSetupDomain(String(body.domain ?? ''));
    const invalid = validateSetupDomain(domain);
    if (invalid) throw new ApiError(invalid);

    const wildcard = body.wildcard === true;
    let wildcardBase: string | null = null;
    if (wildcard) {
      if (!wildcardPossible(state, certificateFactsOf(await getSettings()))) {
        throw new ApiError(
          msg('Ein Wildcard-Zertifikat braucht einen DNS-Anbieter und Zertifikate über ACME. Beides wird in den Schritten davor gewählt.')
        );
      }
      wildcardBase = normalizeSetupDomain(String(body.wildcardBase ?? ''));
      const badBase = validateWildcardBase(domain, wildcardBase);
      if (badBase) throw new ApiError(badBase);
    }

    // Von welchen Adressen die Oberfläche aufrufbar sein soll. Nur aus dem
    // Internet gefragt: intern steht der Server ohnehin nur im eigenen Netz.
    const surfaceIps = state.exposure === 'public' ? normalizeSurfaceIps(body.surfaceIps) : [];
    const badIps = validateSurfaceIps(surfaceIps);
    if (badIps) throw new ApiError(badIps);
    // Wer die eigene Adresse nicht einträgt, sperrt sich mit dem letzten Schritt
    // aus. Nur bei einer öffentlichen Adresse: über einen Tunnel oder aus dem
    // Netz des Servers kommt der Aufrufer später von einer anderen.
    const client = getClientIP(request);
    if (surfaceIps.length > 0 && isPublicAddress(client) && !surfaceIps.some((network) => addressInNetwork(client, network))) {
      throw new ApiError(
        msg('Ihre eigene Adresse {ip} steht nicht in der Liste. Die Oberfläche wäre danach für Sie nicht mehr aufrufbar.', {
          ip: client,
        }),
        409
      );
    }

    // Ein früheres Ausführen gehört zu den früheren Eingaben.
    await updateSetupState({ address: 'set', domain, wildcard, wildcardBase, surfaceIps, execution: null });

    // Mit der Domain steht die Zone fest: sie erscheint ab jetzt unter „DNS".
    // Gelingt das nicht (das Token sieht die Zone nicht), hält es den Schritt
    // nicht auf. Ob es gelungen ist, sagt `dnsZone` in der Antwort.
    const access = await getDnsAccess();
    const dnsProvider = access && access.hook === state.dnsHook ? dnsProviderForHook(access.hook) : null;
    if (access && dnsProvider) {
      const connected = await connectZone({ provider: dnsProvider, domain, token: access.token }).catch(() => null);
      if (connected?.created) {
        await logAudit({
          userId: session.userId,
          userEmail: session.email,
          action: 'dns_zone_created',
          resource: 'dns_zone',
          resourceId: connected.zone.$id,
          details: `${connected.zone.name} (Einrichtung)`,
          ip: getClientIP(request),
        });
      }
    }

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'setup_updated',
      resource: 'settings',
      details:
        `Adresse der Oberfläche: ${domain}${wildcardBase ? `, Wildcard *.${wildcardBase}` : ''}` +
        (surfaceIps.length > 0 ? `, aufrufbar von ${surfaceIps.join(', ')}` : ''),
      ip: getClientIP(request),
    });

    return ok({ setup: await readSetupView(), check: await checkDomainAddress(domain, state.exposure) });
  } catch (err) {
    return handleError(err);
  }
}
