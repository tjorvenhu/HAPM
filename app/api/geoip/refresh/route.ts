import { requireSession, requireCsrf } from '@/lib/session';
import { ok, handleError, ApiError } from '@/lib/api';
import { logAudit, getClientIP } from '@/lib/audit';
import { geoipOverview, refreshGeoip } from '@/lib/geoip/fetch';

/**
 * „Jetzt erneuern": die Länder-Tabelle sofort von db-ip.com holen.
 *
 * Derselbe Abruf, den der Scheduler einmal am Tag versucht, nur ohne dessen
 * 24-Stunden-Sperre: wer klickt, will es jetzt wissen. Die Anfrage wartet, bis
 * der Abruf durch ist. Das sind Sekunden und kein abgekoppelter Lauf.
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();

    const result = await refreshGeoip({ actor: session.email });
    // 502: HAPM selbst ist in Ordnung, die Gegenseite hat nicht geliefert.
    if (!result.ok) throw new ApiError(result.error ?? 'Der Abruf ist gescheitert.', 502);

    const overview = await geoipOverview();
    if (result.changed) {
      await logAudit({
        userId: session.userId,
        userEmail: session.email,
        action: 'geoip_table_updated',
        resource: 'settings',
        resourceId: 'geoip',
        details:
          `Länder-Tabelle von db-ip.com geholt, Stand ${result.version}: ${overview.v4Count} IPv4- und ` +
          `${overview.v6Count} IPv6-Bereiche`,
        ip: getClientIP(request) ?? undefined,
      });
    }

    return ok({ ...overview, changed: result.changed });
  } catch (err) {
    return handleError(err);
  }
}
