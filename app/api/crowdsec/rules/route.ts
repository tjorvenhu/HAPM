import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody } from '@/lib/api';
import { getClientIP } from '@/lib/audit';
import { crowdsecRules, queueRuleChange } from '@/lib/crowdsec/actions';

/** Die Regelsammlungen und der Modus der OWASP-Regeln. */
export async function GET() {
  try {
    await requireSession();
    return ok(await crowdsecRules());
  } catch (err) {
    return handleError(err);
  }
}

/**
 * `{ crs: off|block }`, `{ name, installed }` für eine Sammlung oder `{ upgrade: true }` für den Hub.
 *
 * Antwortet sofort mit `{ runId, key }`: die Änderung läuft als Lauf im
 * Hintergrund (`lib/crowdsec/rule-jobs.ts`), zu lesen unter `rules/runs/<id>`.
 */
export async function PATCH(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody(request);
    const actor = { userId: session.userId, userEmail: session.email, ip: getClientIP(request) };
    return ok(queueRuleChange(body, actor));
  } catch (err) {
    return handleError(err);
  }
}
