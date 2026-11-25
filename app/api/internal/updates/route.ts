import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError } from '@/lib/api';
import { checkUpdatesNow, updatesOverview } from '@/lib/updates/actions';

/**
 * Der Stand der Updates, wie ihn die Seite „Updates" zeigt: je Bestandteil
 * (`haproxy`, `hapm`, `acme`) die laufende und die neueste Fassung, die
 * letzten Läufe, die Schalter für selbsttätige Updates.
 *
 * `?check=1` fragt vorher die Registries und GitHub, wie „Jetzt prüfen".
 * Geholt wird dabei nichts, und wie in der Oberfläche steht das Prüfen nicht
 * im Protokoll: es ändert nur den gespeicherten Stand. Deshalb ein GET mit
 * Parameter und kein eigener schreibender Endpunkt.
 */
export async function GET(request: Request) {
  try {
    await requireServiceToken(request);
    const check = new URL(request.url).searchParams.get('check');
    return ok(check === '1' || check === 'true' ? await checkUpdatesNow() : await updatesOverview());
  } catch (err) {
    return handleError(err);
  }
}
