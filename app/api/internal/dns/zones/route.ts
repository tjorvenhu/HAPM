import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError } from '@/lib/api';
import { getLocale } from '@/lib/i18n/server';
import { checkZones } from '@/lib/dns/zone-check';

/**
 * Die angebundenen DNS-Zonen und ob ihr Zugang gerade geht (fragt den
 * Anbieter). Nur lesend: eine Zone anzubinden braucht den Token des Anbieters,
 * und den nimmt nur die Oberfläche an.
 */
export async function GET(request: Request) {
  try {
    await requireServiceToken(request);
    return ok(await checkZones(await getLocale()));
  } catch (err) {
    return handleError(err);
  }
}
