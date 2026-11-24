import { requireSession, requireCsrf } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { logAudit, getClientIP } from '@/lib/audit';
import { getProxyServer, writeDnsCredentials } from '@/lib/haproxy/provision';
import { LOCAL_SERVER_ID } from '@/lib/helpers';
import { findDnsProvider } from '@/lib/haproxy/dns-credentials';

/**
 * Die DNS-Zugangsdaten einer Proxy-Maschine setzen oder entfernen.
 *
 * ── Warum synchron ──
 *
 * Jeder andere Schreibvorgang am Reverse-Proxy läuft abgekoppelt, weil er
 * Minuten dauert: Zertifikat, `haproxy -c`, Reload. Dieser fasst HAProxy gar
 * nicht an — er schreibt eine Zeile in `account.conf`. Eine Lauf-Zeile, eine
 * Pille unten rechts und ein Abgleich beim Start wären Apparat für einen
 * Vorgang, der fertig ist, bevor die Pille erscheint.
 *
 * ── Was NICHT zurückkommt ──
 *
 * Der Token. Er wird auch nicht gespeichert — HAPM reicht ihn durch und
 * vergisst ihn (siehe `lib/haproxy/dns-credentials.ts`). Zurück kommen die Hooks,
 * die die Maschine danach kennt: das ist der Rückabgleich und zugleich das
 * einzige, was die Oberfläche über den Zustand sagen darf.
 */
export async function PUT(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody<{
      serverId?: string;
      hook?: string;
      values?: Record<string, string>;
    }>(request);

    const server = await getProxyServer(body.serverId || LOCAL_SERVER_ID);

    const hook = String(body.hook ?? '').trim();
    const provider = findDnsProvider(hook);
    if (!provider) throw new ApiError('Unbekannter DNS-Anbieter.');

    // Nur die Felder des Anbieters, und jedes als getrimmter String. Ein
    // Leerzeichen am Ende eines eingefügten Tokens ist der Fehler, den man beim
    // ersten Wildcard-Antrag sucht und nicht findet.
    const values: Record<string, string> = {};
    for (const field of provider.fields) {
      values[field.name] = String(body.values?.[field.name] ?? '').trim();
    }

    const dnsHooks = await writeDnsCredentials(server, { hook, values, remove: false });

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'haproxy_settings_updated',
      resource: 'server',
      resourceId: server.$id,
      // Welche Felder gesetzt wurden, nicht womit. Ein Audit-Eintrag ist die
      // eine Zeile, die dauerhaft stehen bleibt.
      details:
        `DNS-Zugangsdaten für ${provider.label} gesetzt: ` +
        provider.fields
          .filter((field) => values[field.name])
          .map((field) => field.name)
          .join(', '),
      ip: getClientIP(request) ?? undefined,
    });

    return ok({ dnsHooks });
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Die Zugangsdaten eines Anbieters entfernen.
 *
 * Derselbe Weg mit leeren Werten: die `SAVED_`-Zeilen werden herausgefiltert und
 * nichts angehängt. Ein eigener Vorgang und kein „leeres Formular speichern",
 * weil das Formular den Token gar nicht anzeigen kann — leer heißt dort
 * „unverändert" und nicht „weg".
 */
export async function DELETE(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody<{ serverId?: string; hook?: string }>(request);

    const server = await getProxyServer(body.serverId || LOCAL_SERVER_ID);

    const hook = String(body.hook ?? '').trim();
    const provider = findDnsProvider(hook);
    if (!provider) throw new ApiError('Unbekannter DNS-Anbieter.');

    const values = Object.fromEntries(provider.fields.map((field) => [field.name, '']));
    const dnsHooks = await writeDnsCredentials(server, { hook, values, remove: true });

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'haproxy_settings_updated',
      resource: 'server',
      resourceId: server.$id,
      details: `DNS-Zugangsdaten für ${provider.label} entfernt`,
      ip: getClientIP(request) ?? undefined,
    });

    return ok({ dnsHooks });
  } catch (err) {
    return handleError(err);
  }
}
