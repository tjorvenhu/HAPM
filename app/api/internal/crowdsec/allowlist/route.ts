import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError, jsonBody } from '@/lib/api';
import { getClientIP, serviceActor } from '@/lib/audit';
import { listAllowlist, addAllowlist, removeAllowlist } from '@/lib/crowdsec/actions';

/** Die Freigabeliste von HAPM. Freigegebene Adressen sperrt CrowdSec nicht, die WAF prüft sie nicht. */
export async function GET(request: Request) {
  try {
    await requireServiceToken(request);
    return ok({ entries: await listAllowlist() });
  } catch (err) {
    return handleError(err);
  }
}

/** Freigeben: `{ value, description, duration }` (`duration` leer: unbefristet). Hebt bestehende Sperren auf. */
export async function POST(request: Request) {
  try {
    const service = await requireServiceToken(request);
    const body = await jsonBody(request);
    return ok(await addAllowlist(body, { ...serviceActor(service), ip: getClientIP(request) }));
  } catch (err) {
    return handleError(err);
  }
}

/** Eine Freigabe entfernen: `{ value }`. */
export async function DELETE(request: Request) {
  try {
    const service = await requireServiceToken(request);
    const body = await jsonBody(request);
    return ok(await removeAllowlist(body, { ...serviceActor(service), ip: getClientIP(request) }));
  } catch (err) {
    return handleError(err);
  }
}
