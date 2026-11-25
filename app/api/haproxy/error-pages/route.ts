import { requireSession, requireCsrf } from '@/lib/session';
import { ok, handleError, jsonBody } from '@/lib/api';
import { getT } from '@/lib/i18n/server';
import { getClientIP } from '@/lib/audit';
import { readErrorPageRows, redeployErrorPages } from '@/lib/haproxy/maintenance-actions';

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
 * Schritte kommen in der Antwort zurück und stehen im Audit. Die Logik steht in
 * `lib/haproxy/maintenance-actions.ts`, die interne API ruft dieselbe.
 */

export async function GET() {
  try {
    await requireSession();
    const { t, locale } = await getT();
    return ok(await readErrorPageRows(t, locale));
  } catch (err) {
    return handleError(err);
  }
}

/** Die Fehlerdateien und die Seiten der Passwortabfrage neu schreiben, im gespeicherten Design. */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody<{ serverId?: string }>(request);
    return ok(
      await redeployErrorPages(body, { userId: session.userId, userEmail: session.email, ip: getClientIP(request) ?? undefined })
    );
  } catch (err) {
    return handleError(err);
  }
}
