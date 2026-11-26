import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError, jsonBody } from '@/lib/api';
import { getClientIP, serviceActor } from '@/lib/audit';
import { assertRulesWritable, crowdsecRules, changeRules } from '@/lib/crowdsec/actions';

/** Die Regelsammlungen und der Modus der OWASP-Regeln. */
export async function GET(request: Request) {
  try {
    await requireServiceToken(request);
    return ok(await crowdsecRules());
  } catch (err) {
    return handleError(err);
  }
}

/** `{ crs: off|block }`, `{ name, installed }` für eine Sammlung oder `{ upgrade: true }` für den Hub. */
export async function PATCH(request: Request) {
  try {
    const service = await requireServiceToken(request);
    const body = await jsonBody(request);
    await assertRulesWritable(body);
    return ok(await changeRules(body, { ...serviceActor(service), ip: getClientIP(request) }));
  } catch (err) {
    return handleError(err);
  }
}
