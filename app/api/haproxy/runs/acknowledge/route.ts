import { requireSession, requireCsrf } from '@/lib/session';
import { updateDocument } from '@/lib/db';
import { COLLECTIONS } from '@/lib/types';
import { logAudit, getClientIP } from '@/lib/audit';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import type { HaproxyRun } from '@/lib/types';

interface AcknowledgeInput {
  ids?: string[];
}

/**
 * POST /api/haproxy/runs/acknowledge
 *
 * Einen fehlgeschlagenen Vorgang als gesehen abhaken.
 *
 * Das Dashboard zeigt einen Fehlschlag so lange als Handlungsbedarf, wie er der
 * letzte Vorgang für diesen Eintrag ist — ein erfolgreicher zweiter Versuch
 * räumt ihn also von selbst weg. Diese Route ist für den anderen Fall: behoben
 * wurde etwas anderswo (von Hand auf der Maschine, oder der Eintrag ist
 * inzwischen weg), und deshalb wird es nie einen zweiten Lauf geben, der die
 * Meldung ablöst.
 *
 * Der Lauf bleibt im Protokoll stehen. Abhaken ist nicht löschen — dieselbe
 * Regel wie bei den Backup-Protokollen.
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const input = await jsonBody<AcknowledgeInput>(request);

    const ids = Array.isArray(input.ids)
      ? input.ids.filter((id) => typeof id === 'string' && id)
      : [];
    if (ids.length === 0) throw new ApiError('Keine Einträge angegeben.');

    // Eine Aktualisierung je Lauf. Die Menge ist durch das begrenzt, was das
    // Dashboard auflistet (die letzten 25 Läufe).
    await Promise.all(
      ids.map((id) =>
        updateDocument<HaproxyRun>(COLLECTIONS.HAPROXY_RUNS, id, { acknowledged: true })
      )
    );

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'haproxy_failure_acknowledged',
      resource: 'haproxy_run',
      details: `${ids.length} fehlgeschlagene(r) Reverse-Proxy-Vorgang/Vorgänge als geprüft markiert`,
      ip: getClientIP(request),
    });

    return ok({ acknowledged: ids.length });
  } catch (err) {
    return handleError(err);
  }
}
