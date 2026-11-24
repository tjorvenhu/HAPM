import { requireSession, requireCsrf } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { getT } from '@/lib/i18n/server';
import { logAudit, getClientIP } from '@/lib/audit';
import { getProxyServer, readErrorPages } from '@/lib/haproxy/provision';
import { applyPageDesign } from '@/lib/haproxy/page-design-apply';
import { loadPageDesign } from '@/lib/haproxy/page-design-store';
import type { ErrorPageEntry } from '@/lib/haproxy/error-pages';
import { LOCAL_SERVER_ID, localServer } from '@/lib/helpers';

/**
 * Die Fehlerseiten von HAProxy: welche Dateien `haproxy.cfg` nennt, was darin
 * steht, und der Vorgang, der sie auf den Stand des gespeicherten Designs
 * bringt. Das Design selbst hat seine eigene Route (`./design`).
 *
 * Hinter den Dateien steht keine Collection. Gelesen wird von der Maschine, bei
 * jedem Aufruf, und verglichen mit dem, was aus dem gespeicherten Design jetzt
 * entstünde.
 *
 * ── Warum synchron ──
 *
 * Kein Zertifikat, keine neue Konfiguration: eine Handvoll kleiner Dateien, ein
 * `haproxy -c`, ein Reload. Dieselbe Abwägung wie bei den DNS-Zugangsdaten. Die
 * Schritte kommen in der Antwort zurück und stehen im Audit.
 */

interface ErrorPagesRow {
  $id: string;
  name: string;
  entries: ErrorPageEntry[];
  error: string | null;
}

export async function GET() {
  try {
    await requireSession();
    const { t, locale } = await getT();

    // Der Zustand einer Datei ist ein Vergleich mit dem gespeicherten Design.
    await loadPageDesign();
    const servers = [localServer()];

    // Einzeln scheitern lassen: ein Proxy, der gerade nicht antwortet, ist eine
    // Auskunft und kein Grund, die übrigen wegzulassen.
    const rows: ErrorPagesRow[] = await Promise.all(
      servers.map(async (server) => {
        const base = { $id: server.$id, name: server.name };
        try {
          return { ...base, entries: await readErrorPages(server), error: null };
        } catch (err) {
          return {
            ...base,
            entries: [],
            error:
              err instanceof ApiError
                ? err.localized(locale)
                : err instanceof Error
                  ? err.message
                  : t('HAProxy ist nicht erreichbar.'),
          };
        }
      })
    );

    rows.sort((a, b) => a.name.localeCompare(b.name, 'de'));
    return ok(rows);
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Die Fehlerdateien und die Seiten der Passwortabfrage neu schreiben, im
 * gespeicherten Design.
 *
 * Der Rumpf nennt nur die Maschine. WELCHE Dateien geschrieben werden und mit
 * welchem Status, liest der Vorgang selbst und innerhalb des Locks: eine Liste
 * aus dem Browser wäre eine Momentaufnahme von vorhin und ein Pfad, den jemand
 * anderes bestimmt hat.
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody<{ serverId?: string }>(request);

    const server = await getProxyServer(body.serverId || LOCAL_SERVER_ID);

    await loadPageDesign();
    const result = await applyPageDesign(server);
    const failed = result.steps.find((step) => !step.ok);

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: failed ? 'haproxy_error_pages_failed' : 'haproxy_error_pages_updated',
      resource: 'server',
      resourceId: server.$id,
      details:
        'Fehlerseiten: ' +
        result.steps.map((step) => `${step.ok ? '' : 'fehlgeschlagen: '}${step.label}`).join(', '),
      ip: getClientIP(request) ?? undefined,
    });

    return ok(result);
  } catch (err) {
    return handleError(err);
  }
}
