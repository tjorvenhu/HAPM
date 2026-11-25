import { requireSession, requireCsrf } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n/translate';
import { getT } from '@/lib/i18n/server';
import { logAudit, getClientIP } from '@/lib/audit';
import { getProxyServer, readBaseConfigDiff, updateBaseConfig } from '@/lib/haproxy/provision';
import type { BaseConfigDiff } from '@/lib/haproxy/base-config-diff';
import { LOCAL_SERVER_ID, localServer } from '@/lib/helpers';

/**
 * Der Abgleich von `haproxy.cfg` mit der Grundkonfiguration, die HAPM heute
 * schreiben würde (`lib/haproxy/base-config-diff.ts`), und das Übernehmen
 * einzelner Abweichungen.
 *
 * Gelesen wird bei jedem Aufruf aus der Datei. Geschrieben wird synchron wie
 * bei den Fehlerseiten: kein Zertifikat, ein `haproxy -c`, ein Reload. Die
 * Schritte kommen in der Antwort zurück und stehen im Audit.
 */

interface BaseConfigRow {
  $id: string;
  name: string;
  diff: BaseConfigDiff | null;
  error: string | null;
}

/** Eine Auswahl ist klein. Mehr als das kommt aus keiner Oberfläche. */
const MAX_IDS = 200;

/** `global|missing|limited-quic` wird zu `global: limited-quic`. Gekürzt, weil
 *  eine lange Auswahl sonst die Zeile im Protokoll sprengt. */
function auditDetails(ids: string[], failed: string | null): string {
  const lines = ids.map((id) => id.replace(/\|(missing|changed)\|/, ': ')).join(', ');
  const text = `Grundkonfiguration abgeglichen: ${lines}${failed ? ` (fehlgeschlagen: ${failed})` : ''}`;
  return text.length > 1000 ? `${text.slice(0, 997)}...` : text;
}

export async function GET() {
  try {
    await requireSession();
    const { t, locale } = await getT();

    const servers = [localServer()];
    const rows: BaseConfigRow[] = await Promise.all(
      servers.map(async (server) => {
        const base = { $id: server.$id, name: server.name };
        try {
          return { ...base, diff: await readBaseConfigDiff(server), error: null };
        } catch (err) {
          return {
            ...base,
            diff: null,
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

    return ok(rows);
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Die ausgewählten Abweichungen übernehmen. Der Rumpf nennt sie mit ihrer ID
 * aus dem Abgleich. Welche Zeile wohin kommt, rechnet der Vorgang selbst und
 * innerhalb des Locks: gibt es eine ID nicht mehr, bricht er ab.
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody<{ serverId?: string; ids?: unknown }>(request);

    const ids = Array.isArray(body.ids) ? body.ids : [];
    if (ids.length === 0 || ids.length > MAX_IDS || !ids.every((id) => typeof id === 'string')) {
      throw new ApiError(msg('Es wurde keine Abweichung ausgewählt.'));
    }

    const server = await getProxyServer(body.serverId || LOCAL_SERVER_ID);
    const result = await updateBaseConfig(server, ids as string[]);
    const failed = result.steps.find((step) => !step.ok);

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: failed ? 'haproxy_base_config_failed' : 'haproxy_base_config_updated',
      resource: 'server',
      resourceId: server.$id,
      details: auditDetails(ids as string[], failed?.label ?? null),
      ip: getClientIP(request) ?? undefined,
    });

    return ok(result);
  } catch (err) {
    return handleError(err);
  }
}
