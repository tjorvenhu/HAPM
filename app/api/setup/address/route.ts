import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { logAudit, getClientIP } from '@/lib/audit';
import { updateSettings } from '@/lib/settings';
import { readSetupView } from '@/lib/setup';
import { checkDomainAddress } from '@/lib/setup/address';
import {
  normalizeSetupDomain,
  validateSetupDomain,
  validateWildcardBase,
} from '@/lib/setup/rules';
import { getSetupState, updateSetupState } from '@/lib/setup/store';

/**
 * Schritt 4 der Einrichtung: die Domain, unter der die Oberfläche stehen soll.
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
    return ok(await checkDomainAddress(domain));
  } catch (err) {
    return handleError(err);
  }
}

export async function PUT(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody<{
      domain?: unknown;
      wildcard?: unknown;
      wildcardBase?: unknown;
      skip?: unknown;
    }>(request);

    const state = await getSetupState();
    if (!state.exposure) throw new ApiError('Bitte wählen Sie zuerst die Erreichbarkeit.');

    if (body.skip === true) {
      if (state.exposure === 'internal') {
        throw new ApiError('Eine interne Installation braucht die Adresse der Oberfläche.');
      }
      await updateSetupState({ address: 'skipped', domain: null, wildcard: false, wildcardBase: null, execution: null });
      // Ohne Adresse gibt es nichts auszuführen: die Einrichtung ist damit zu Ende.
      await updateSettings({ setupStatus: 'done' });
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
      if (state.dns !== 'configured') {
        throw new ApiError('Ein Wildcard-Zertifikat braucht einen DNS-Anbieter. Er wird im Schritt davor eingerichtet.');
      }
      wildcardBase = normalizeSetupDomain(String(body.wildcardBase ?? ''));
      const badBase = validateWildcardBase(domain, wildcardBase);
      if (badBase) throw new ApiError(badBase);
    }

    // Ein früheres Ausführen gehört zu den früheren Eingaben.
    await updateSetupState({ address: 'set', domain, wildcard, wildcardBase, execution: null });
    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'setup_updated',
      resource: 'settings',
      details: `Adresse der Oberfläche: ${domain}${wildcardBase ? `, Wildcard *.${wildcardBase}` : ''}`,
      ip: getClientIP(request),
    });

    return ok({ setup: await readSetupView(), check: await checkDomainAddress(domain) });
  } catch (err) {
    return handleError(err);
  }
}
