import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { logAudit, getClientIP } from '@/lib/audit';
import { localServer } from '@/lib/helpers';
import { probeProxy, writeDnsCredentials } from '@/lib/haproxy/provision';
import { findDnsProvider, validateDnsCredentials } from '@/lib/haproxy/dns-credentials';
import { readSetupView } from '@/lib/setup';
import { checkDnsToken } from '@/lib/setup/token-check';
import { getSetupState, updateSetupState } from '@/lib/setup/store';

/**
 * Schritt 3 der Einrichtung: der DNS-Anbieter.
 *
 * Drei Antworten. Zugangsdaten eintragen (`hook`, `values`), einen schon
 * eingerichteten Hook übernehmen (`keep`) oder den Schritt überspringen
 * (`skip`), was nur eine öffentliche Installation darf.
 *
 * Geschrieben wird über denselben Weg wie unter Reverse-Proxy, Einstellungen
 * (`writeDnsCredentials`): der Token geht durch nach `account.conf` und steht
 * danach weder in der Datenbank noch im Protokoll. Gemerkt wird nur, welcher
 * Hook gewählt ist. Über Erfolg entscheidet der Rückabgleich: was acme.sh
 * danach über seine Hooks sagt.
 */
export async function PUT(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody<{
      hook?: unknown;
      values?: Record<string, unknown>;
      keep?: unknown;
      skip?: unknown;
    }>(request);

    const state = await getSetupState();
    if (!state.exposure) throw new ApiError('Bitte wählen Sie zuerst die Erreichbarkeit.');

    const audit = (details: string) =>
      logAudit({
        userId: session.userId,
        userEmail: session.email,
        action: 'setup_updated',
        resource: 'settings',
        details,
        ip: getClientIP(request),
      });

    if (body.skip === true) {
      if (state.exposure === 'internal') {
        throw new ApiError(
          'Eine interne Installation braucht einen DNS-Anbieter: ohne ihn lässt sich kein Zertifikat ausstellen.'
        );
      }
      // Ohne Anbieter gibt es keine Wildcard.
      await updateSetupState({ dns: 'skipped', dnsHook: null, wildcard: false, wildcardBase: null });
      await audit('DNS-Anbieter: übersprungen');
      return ok({ setup: await readSetupView(), tokenCheck: null });
    }

    const server = localServer();

    if (typeof body.keep === 'string') {
      const hook = body.keep.trim();
      const { dnsHooks } = await probeProxy(server);
      if (!dnsHooks.includes(hook)) {
        throw new ApiError(`Der DNS-Hook "${hook}" ist bei acme.sh nicht eingerichtet.`);
      }
      await updateSetupState({ dns: 'configured', dnsHook: hook });
      await audit(`DNS-Anbieter: ${hook} übernommen`);
      return ok({ setup: await readSetupView(), tokenCheck: null });
    }

    const hook = String(body.hook ?? '').trim();
    const provider = findDnsProvider(hook);
    if (!provider) throw new ApiError('Bitte wählen Sie einen DNS-Anbieter.');

    const values: Record<string, string> = {};
    for (const field of provider.fields) {
      values[field.name] = String(body.values?.[field.name] ?? '').trim();
    }
    const invalid = validateDnsCredentials({ hook, values, remove: false });
    if (invalid) throw new ApiError(invalid);

    // Vor dem Ablegen: ein abgelehnter Token soll nichts hinterlassen.
    const tokenCheck = await checkDnsToken(hook, values);
    if (tokenCheck.result === 'rejected') throw new ApiError(tokenCheck.message);

    const dnsHooks = await writeDnsCredentials(server, { hook, values, remove: false });
    if (!dnsHooks.includes(hook)) {
      throw new ApiError(
        `Die Zugangsdaten sind abgelegt, acme.sh erkennt den Hook ${hook} aber nicht. ` +
          'Ob acme.sh eingerichtet ist, steht in der Übersicht.'
      );
    }

    await updateSetupState({ dns: 'configured', dnsHook: hook });
    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'haproxy_settings_updated',
      resource: 'server',
      resourceId: server.$id,
      // Welche Felder gesetzt wurden, nicht womit.
      details:
        `DNS-Zugangsdaten für ${provider.label} gesetzt (Einrichtung): ` +
        provider.fields
          .filter((field) => values[field.name])
          .map((field) => field.name)
          .join(', '),
      ip: getClientIP(request),
    });

    return ok({ setup: await readSetupView(), tokenCheck });
  } catch (err) {
    return handleError(err);
  }
}
