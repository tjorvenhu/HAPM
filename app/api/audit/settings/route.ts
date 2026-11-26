import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody } from '@/lib/api';
import { getClientIP } from '@/lib/audit';
import { auditOverview, changeAuditSettings, readAuditSettingsInput } from '@/lib/audit-log/actions';

/** Aufbewahrung, Weiterleitung und ihr Zustand (letzte Zustellung, Rückstand, Fehler). */
export async function GET() {
  try {
    await requireSession();
    return ok(await auditOverview());
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Teil-Patch: `retentionDays`, `syslog`, `http`. Prüfung und Protokoll stehen
 * in `changeAuditSettings`. Nur mit Sitzung: über einen API-Key lässt sich die
 * Weiterleitung nicht umstellen (`lib/audit-log/settings.ts`).
 */
export async function PATCH(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const input = readAuditSettingsInput(await jsonBody(request));
    return ok(
      await changeAuditSettings(input, { userId: session.userId, userEmail: session.email, ip: getClientIP(request) })
    );
  } catch (err) {
    return handleError(err);
  }
}
