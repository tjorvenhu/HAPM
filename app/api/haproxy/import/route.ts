import { requireSession, requireCsrf } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { getT } from '@/lib/i18n/server';
import { getClientIP, logAudit } from '@/lib/audit';
import { getProxyServer, probeProxy } from '@/lib/haproxy/provision';
import { startHaproxyRun } from '@/lib/haproxy/runner';
import { getSettings } from '@/lib/settings';
import { findScope, parseScopes } from '@/lib/haproxy/config';
import {
  IMPORT_MAX_BYTES,
  assessImport,
  importTextError,
  newScopeError,
  parseImport,
} from '@/lib/haproxy/import';
import { importTitle, type ImportPlan } from '@/lib/haproxy/import-run';
import { LOCAL_SERVER_ID } from '@/lib/helpers';

/**
 * Einen Import ausführen.
 *
 * Der Browser schickt den Text und die SCHLÜSSEL der gewählten Einträge, nicht
 * die Einträge selbst. Gelesen wird hier noch einmal, mit derselben Funktion
 * wie in der Vorschau: eine Eingabe, die aus dem Browser kommt, wäre eine, die
 * jeder Aufrufer frei zusammensetzen kann, und der Parser ist die eine Stelle,
 * die entscheidet, was aus einer Zeile wird.
 *
 * Was sich ohne Schreiben prüfen lässt, wird vorher geprüft: die Gruppe, und
 * ob jeder gewählte Eintrag gegen den jetzigen Stand noch übernehmbar ist.
 * Eine Lage, die sich seit der Vorschau geändert hat, gehört auf die Seite
 * zurück und nicht in die Historie. Der Rest läuft als EIN abgekoppelter Lauf
 * (`lib/haproxy/import-run.ts`).
 *
 * Die Prüfung rechnet zweimal: in der Sprache der Anfrage für eine Meldung,
 * auf Deutsch für das, was der Lauf speichert (Titel der Einträge).
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();

    if (Number(request.headers.get('content-length') ?? 0) > IMPORT_MAX_BYTES * 3) {
      throw new ApiError(msg('Die Konfiguration ist größer als {size} MB.', { size: IMPORT_MAX_BYTES / 1_000_000 }), 413);
    }
    const { t } = await getT();
    const body = await jsonBody<{
      text?: unknown;
      keys?: unknown;
      scope?: unknown;
      newScope?: unknown;
      dnsHook?: unknown;
    }>(request);

    const text = typeof body.text === 'string' ? body.text : '';
    const invalid = importTextError(text);
    if (invalid) throw new ApiError(invalid, invalid.text.includes('MB') ? 413 : 400);

    const keys = Array.isArray(body.keys) ? [...new Set(body.keys.map((k) => String(k)))] : [];
    if (keys.length === 0) throw new ApiError(msg('Es wurde kein Eintrag ausgewählt.'));

    const scopeName = String(body.scope ?? '').trim();
    const createScope = body.newScope === true;
    const dnsHook = typeof body.dnsHook === 'string' && body.dnsHook.trim() ? body.dnsHook.trim() : null;

    const server = await getProxyServer(LOCAL_SERVER_ID);
    const [probe, { exposure }] = await Promise.all([probeProxy(server), getSettings()]);
    if (!probe.configReadable) {
      throw new ApiError(msg('Die HAProxy-Konfiguration ist nicht lesbar. Der Zustand steht in der Übersicht.'), 409);
    }

    const scopes = parseScopes(probe.raw);
    let scope: string;
    if (createScope) {
      const refused = newScopeError(scopeName, scopes);
      if (refused) throw new ApiError(refused, 409);
      scope = scopeName.toUpperCase();
    } else {
      const found = findScope(scopes, scopeName);
      if (!found || !found.complete) {
        throw new ApiError(msg('Die Gruppe „{name}" gibt es nicht oder nicht vollständig.', { name: scopeName }), 409);
      }
      scope = found.name;
    }

    // Ohne `busyPorts`: ob auf einem Port etwas lauscht, fragt der Lauf
    // innerhalb des Locks ohnehin noch einmal.
    const assessed = assessImport(
      parseImport(text, t).entries,
      {
        config: probe.raw,
        exposure,
        dnsHooks: probe.dnsHooks,
        dnsHook,
        acmeReady: probe.acmeReady,
        busyPorts: {},
      },
      t
    );
    const byKey = new Map(assessed.map((entry) => [entry.key, entry]));
    const chosen = keys.map((key) => {
      const entry = byKey.get(key);
      if (!entry) {
        throw new ApiError(msg('Die Auswahl passt nicht zum Text. Lassen Sie die Vorschau neu berechnen.'), 409);
      }
      if (entry.state !== 'ready') {
        throw new ApiError(
          entry.reason
            ? msg('{entry} lässt sich nicht mehr übernehmen: {reason} Lassen Sie die Vorschau neu berechnen.', {
                entry: importTitle(entry, t),
                reason: entry.reason,
              })
            : msg('{entry} lässt sich nicht mehr übernehmen. Lassen Sie die Vorschau neu berechnen.', {
                entry: importTitle(entry, t),
              }),
          409
        );
      }
      return entry;
    });

    // In der Reihenfolge der Datei, nicht der Auswahl.
    chosen.sort((a, b) => a.line - b.line);
    const plan: ImportPlan = {
      scope,
      createScope,
      items: chosen.map((entry) => ({
        key: entry.key,
        title: importTitle(entry),
        service: entry.service,
        stream: entry.stream,
      })),
    };

    const actor = { userId: session.userId, email: session.email, ip: getClientIP(request) };
    const run = await startHaproxyRun({
      server,
      action: 'import',
      serviceId: scope,
      importPlan: plan,
      challenge: { exposure, dnsHook },
      actor,
    });

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'haproxy_import_started',
      resource: 'server',
      resourceId: server.$id,
      details: `${plan.items.length} Einträge in ${scope}${createScope ? ' (neue Gruppe)' : ''}: ${plan.items.map((i) => i.title).join(', ')}`,
      ip: actor.ip ?? undefined,
    });

    return ok({ runId: run.$id, scope });
  } catch (err) {
    return handleError(err);
  }
}
