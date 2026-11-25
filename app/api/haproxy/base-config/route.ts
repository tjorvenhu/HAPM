import { requireSession, requireCsrf } from '@/lib/session';
import { ok, handleError, jsonBody } from '@/lib/api';
import { getT } from '@/lib/i18n/server';
import { getClientIP } from '@/lib/audit';
import { applyBaseConfig, readBaseConfigRows } from '@/lib/haproxy/maintenance-actions';

/**
 * Der Abgleich von `haproxy.cfg` mit der Grundkonfiguration, die HAPM heute
 * schreiben würde (`lib/haproxy/base-config-diff.ts`), und das Übernehmen
 * einzelner Abweichungen.
 *
 * Gelesen wird bei jedem Aufruf aus der Datei. Geschrieben wird synchron wie
 * bei den Fehlerseiten: kein Zertifikat, ein `haproxy -c`, ein Reload. Die
 * Schritte kommen in der Antwort zurück und stehen im Audit. Die Logik steht
 * in `lib/haproxy/maintenance-actions.ts`, die interne API ruft dieselbe.
 */

export async function GET() {
  try {
    await requireSession();
    const { t, locale } = await getT();
    return ok(await readBaseConfigRows(t, locale));
  } catch (err) {
    return handleError(err);
  }
}

/** Die ausgewählten Abweichungen übernehmen (`ids` aus dem Abgleich). */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody<{ serverId?: string; ids?: unknown }>(request);
    return ok(
      await applyBaseConfig(body, { userId: session.userId, userEmail: session.email, ip: getClientIP(request) ?? undefined })
    );
  } catch (err) {
    return handleError(err);
  }
}
