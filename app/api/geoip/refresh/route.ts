import { requireSession, requireCsrf } from '@/lib/session';
import { ok, handleError } from '@/lib/api';
import { getClientIP } from '@/lib/audit';
import { refreshGeoipNow } from '@/lib/geoip/actions';

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
    return ok(
      await refreshGeoipNow({ userId: session.userId, userEmail: session.email, ip: getClientIP(request) ?? undefined })
    );
  } catch (err) {
    return handleError(err);
  }
}
