import { requireSession } from '@/lib/session';
import { listDocuments, Query } from '@/lib/db';
import { COLLECTIONS } from '@/lib/types';
import { ok, handleError } from '@/lib/api';
import { componentLabel } from '@/lib/updates/apply';
import type { HaproxyRun, UpdateRun } from '@/lib/types';

export interface ActivityJob {
  id: string;
  kind: 'haproxy' | 'update';
  /** Was läuft: die Dienst-ID samt Maschine, bei einem Update der Bestandteil. */
  name: string;
  /** Ein Update-Lauf kennt keine Phase, nur Schritte. */
  phase: string | null;
  startedAt: string;
}

/**
 * Alles, was gerade im Hintergrund läuft: Vorgänge am Reverse-Proxy und
 * Updates. Das ist die Quelle der Pille unten rechts, also gehört hier alles
 * hinein, was länger läuft als eine Anfrage und eine Zeile in der Datenbank hat.
 *
 * Ein Lauf, dessen treibender Prozess gestorben ist (Neustart, Absturz), steht
 * hier bis zum nächsten Abgleich weiter als `running`: sichtbar statt
 * versteckt. Der Abgleich beim Start räumt ihn auf.
 */
export async function GET() {
  try {
    await requireSession();

    const [haproxy, updates] = await Promise.all([
      listDocuments<HaproxyRun>(COLLECTIONS.HAPROXY_RUNS, [
        Query.equal('status', 'running'),
        Query.orderDesc('startedAt'),
        Query.limit(50),
      ]),
      listDocuments<UpdateRun>(COLLECTIONS.UPDATE_RUNS, [
        Query.equal('status', 'running'),
        Query.orderDesc('startedAt'),
        Query.limit(50),
      ]),
    ]);

    const jobs: ActivityJob[] = [
      // Dieselbe Beschriftung wie die Überschrift des Overlays (`/api/haproxy/runs/[id]`).
      ...haproxy.map((run) => ({
        id: run.$id,
        kind: 'haproxy' as const,
        name: `${run.serviceId} · ${run.serverName}`,
        phase: run.phase,
        startedAt: run.startedAt,
      })),
      ...updates.map((run) => ({
        id: run.$id,
        kind: 'update' as const,
        name: componentLabel(run.component),
        phase: null,
        startedAt: run.startedAt,
      })),
    ].sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    return ok({ jobs });
  } catch (err) {
    return handleError(err);
  }
}
