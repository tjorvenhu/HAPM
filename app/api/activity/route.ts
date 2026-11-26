import { requireSession } from '@/lib/session';
import { listDocuments, Query } from '@/lib/db';
import { COLLECTIONS } from '@/lib/types';
import { ok, handleError } from '@/lib/api';
import { componentLabel } from '@/lib/updates/apply';
import { BACKUP_RUNS } from '@/lib/backup/settings';
import { activeRestore } from '@/lib/backup/restore';
import { activeRuleRuns } from '@/lib/crowdsec/rule-jobs';
import type { SyncRun } from '@/lib/sync/store';
import { getT } from '@/lib/i18n/server';
import type { BackupRun } from '@/lib/backup/run';
import type { HaproxyRun, UpdateComponent, UpdateRun } from '@/lib/types';
import type { RunKind } from '@/components/runs/runs';

export interface ActivityJob {
  id: string;
  kind: RunKind;
  /** Was läuft: die Dienst-ID samt Maschine, bei einem Update der Bestandteil, bei einer Sicherung der Ordner. */
  name: string;
  /** Nur ein Reverse-Proxy-Vorgang kennt Phasen, die anderen Läufe nur Schritte. */
  phase: string | null;
  /** Der Bestandteil eines Updates: beim Tausch von HAPM ist die Oberfläche kurz weg. */
  component?: UpdateComponent;
  /** Nur Regeln von CrowdSec: der Schritt, der gerade läuft, schon übersetzt. */
  step?: string | null;
  startedAt: string;
}

/**
 * Alles, was gerade im Hintergrund läuft: Vorgänge am Reverse-Proxy, Updates,
 * Sicherungen, das Zurückspielen, Änderungen an den Regeln von CrowdSec und der
 * Abgleich zwischen Knoten.
 * Das ist die Quelle der Pille unten rechts, also gehört hier alles hinein,
 * was länger läuft als eine Anfrage.
 *
 * Ein Lauf, dessen treibender Prozess gestorben ist (Neustart, Absturz), steht
 * hier bis zum nächsten Abgleich weiter als `running`: sichtbar statt
 * versteckt. Der Abgleich beim Start räumt ihn auf.
 */
export async function GET() {
  try {
    await requireSession();

    const running = [Query.equal('status', 'running'), Query.orderDesc('startedAt'), Query.limit(50)];
    const [haproxy, updates, backups, syncs] = await Promise.all([
      listDocuments<HaproxyRun>(COLLECTIONS.HAPROXY_RUNS, running),
      listDocuments<UpdateRun>(COLLECTIONS.UPDATE_RUNS, running),
      listDocuments<BackupRun>(BACKUP_RUNS, running),
      listDocuments<SyncRun>(COLLECTIONS.SYNC_RUNS, running),
    ]);
    const restore = activeRestore();
    const { t } = await getT();

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
        component: run.component,
        startedAt: run.startedAt,
      })),
      ...backups.map((run) => ({
        id: run.$id,
        kind: 'backup' as const,
        name: run.hostPath,
        phase: null,
        startedAt: run.startedAt,
      })),
      ...(restore
        ? [{ id: restore.runId, kind: 'restore' as const, name: restore.name, phase: null, startedAt: restore.startedAt }]
        : []),
      ...syncs.map((run) => ({
        id: run.$id,
        kind: 'sync' as const,
        name: run.peers,
        phase: null,
        startedAt: run.startedAt,
      })),
      ...activeRuleRuns(t).map((run) => ({
        id: run.id,
        kind: 'crowdsec' as const,
        name: t('CrowdSec-Regeln'),
        phase: null,
        step: run.step,
        startedAt: run.startedAt,
      })),
    ].sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    return ok({ jobs });
  } catch (err) {
    return handleError(err);
  }
}
