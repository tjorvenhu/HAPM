import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError } from '@/lib/api';
import { readAuditLog, readAuditQuery } from '@/lib/audit-log/read';

/**
 * Das Protokoll für ein SIEM, das selbst abholt.
 *
 * Mit `?after=<cursor>` liest ein Aufrufer vom Ältesten an weiter und reicht
 * den `cursor` der Antwort in die nächste Anfrage: so bekommt er jeden Eintrag
 * genau einmal. Ohne `after` kommt das Neueste zuerst. Filter: `from`, `to`,
 * `actor`, `area`, `q`, dazu `limit` (bis 1000).
 *
 * Nur lesend, also ohne Zeile im Protokoll: ein SIEM fragt im Minutentakt.
 * Aufbewahrung und Weiterleitung lassen sich über einen Key nicht ändern.
 */
export async function GET(request: Request) {
  try {
    await requireServiceToken(request);
    const query = readAuditQuery(Object.fromEntries(new URL(request.url).searchParams));
    return ok(await readAuditLog(query));
  } catch (err) {
    return handleError(err);
  }
}
