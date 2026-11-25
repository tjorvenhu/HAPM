import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { checkAddressMove } from '@/lib/address-move';

/**
 * Die Prüfung einer neuen Adresse für HAPM (`?domain=`): DNS, Zone,
 * Zertifikat, wie im Umzugsassistenten. Nur lesend.
 *
 * Den Umzug selbst gibt es hier nicht: er ändert die Adresse, über die API und
 * MCP erreichbar sind, und löscht alle Passkeys. Den Stand eines laufenden
 * Umzugs auch nicht: wer ihn liest, gibt das alte Ziel zum Entfernen frei
 * (`readAddressMoveView`), und das soll das Fenster tun, das umzieht.
 */
export async function GET(request: Request) {
  try {
    await requireServiceToken(request);
    const domain = new URL(request.url).searchParams.get('domain');
    if (!domain) throw new ApiError(msg('Es fehlt die Domain, die geprüft werden soll.'));
    return ok(await checkAddressMove(domain));
  } catch (err) {
    return handleError(err);
  }
}
