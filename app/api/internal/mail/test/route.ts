import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError, jsonBody } from '@/lib/api';
import { getClientIP, serviceActor } from '@/lib/audit';
import { sendTestMailAs } from '@/lib/settings-actions';

/**
 * Eine Testmail über das gespeicherte SMTP-Konto an `to` (Pflicht: ein Token
 * hat keine eigene Adresse). Dieselbe Begrenzung wie in der Oberfläche, fünf
 * je zehn Minuten und Token.
 */
export async function POST(request: Request) {
  try {
    const service = await requireServiceToken(request);
    const body = await jsonBody(request);
    return ok(await sendTestMailAs(body.to, { ...serviceActor(service), ip: getClientIP(request) }, null));
  } catch (err) {
    return handleError(err);
  }
}
