import { requireSession, requireCsrf } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { getT } from '@/lib/i18n/server';
import { getProxyServer, probeProxy, checkStreamPort } from '@/lib/haproxy/provision';
import { getSettings } from '@/lib/settings';
import { parseScopes } from '@/lib/haproxy/config';
import { bindConflict } from '@/lib/haproxy/streams';
import {
  IMPORT_MAX_BYTES,
  assessImport,
  importTextError,
  parseImport,
  suggestScopeName,
  type ImportPreview,
} from '@/lib/haproxy/import';
import { LOCAL_SERVER_ID } from '@/lib/helpers';

/**
 * Die Vorschau eines Imports: was aus dem Text würde, gemessen an der Datei,
 * die JETZT auf der Maschine steht.
 *
 * Ein POST, weil der Text bis zu einem Megabyte hat und in keine Adresse
 * gehört. Geschrieben wird hier nichts, und deshalb steht kein Audit-Eintrag
 * da: wer fünfmal in die Vorschau schaut, hat nichts getan, was im Protokoll
 * gesucht würde. Der Import selbst steht dort (`/api/haproxy/import`).
 *
 * Gründe und Hinweise kommen in der Sprache der Anfrage (`parseImport(text, t)`).
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    await requireSession();

    // Vor dem Lesen: ein Rumpf, der als JSON schon viel größer ist als jede
    // Konfiguration, wird gar nicht erst entpackt.
    if (Number(request.headers.get('content-length') ?? 0) > IMPORT_MAX_BYTES * 3) {
      throw new ApiError(msg('Die Konfiguration ist größer als {size} MB.', { size: IMPORT_MAX_BYTES / 1_000_000 }), 413);
    }
    const { t } = await getT();
    const body = await jsonBody<{ text?: unknown; dnsHook?: unknown }>(request);
    const text = typeof body.text === 'string' ? body.text : '';
    const invalid = importTextError(text);
    if (invalid) throw new ApiError(invalid, invalid.text.includes('MB') ? 413 : 400);

    const server = await getProxyServer(LOCAL_SERVER_ID);
    const [probe, { exposure }] = await Promise.all([probeProxy(server), getSettings()]);
    if (!probe.configReadable) {
      throw new ApiError(msg('Die HAProxy-Konfiguration ist nicht lesbar. Der Zustand steht in der Übersicht.'), 409);
    }

    const result = parseImport(text, t);

    /* Ob auf einem Port schon etwas anderes lauscht, sagt nur die Maschine
     * (`ss`). Gefragt wird nur für Ports, die sonst übernehmbar wären: jede
     * Frage ist eine Runde. */
    const busyPorts: Record<number, string> = {};
    for (const entry of result.entries) {
      const port = entry.stream?.port;
      if (port === undefined || bindConflict(probe.raw, port)) continue;
      const check = await checkStreamPort(server, port, undefined, t);
      if (!check.free && check.reason) busyPorts[port] = check.reason;
    }

    const dnsHook = typeof body.dnsHook === 'string' && body.dnsHook.trim() ? body.dnsHook.trim() : null;
    // Angeboten werden nur vollständige Gruppen, ein neuer Name darf aber auch
    // keiner halben gleichen.
    const allScopes = parseScopes(probe.raw);
    const scopes = allScopes.filter((scope) => scope.complete);

    const preview: ImportPreview = {
      entries: assessImport(
        result.entries,
        {
          config: probe.raw,
          exposure,
          dnsHooks: probe.dnsHooks,
          dnsHook,
          acmeReady: probe.acmeReady,
          busyPorts,
        },
        t
      ),
      skipped: result.skipped,
      scopes: scopes.map((scope) => ({ name: scope.name, label: scope.label })),
      suggestedScope: suggestScopeName(allScopes),
      exposure,
      dnsHooks: probe.dnsHooks,
      acmeReady: probe.acmeReady,
    };
    return ok(preview);
  } catch (err) {
    return handleError(err);
  }
}
