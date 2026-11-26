/**
 * Was eine Überwachung von außen abruft: das Urteil (`GET /api/internal/health`)
 * und die Metriken (`GET /api/internal/metrics`). Beide lesen dieselbe
 * Übersicht wie die Startseite und rechnen nichts ein zweites Mal aus.
 */

import type { Translator } from '../i18n';
import { getBackupSettings } from '../backup/settings';
import { listBackupRuns } from '../backup/run';
import { forwardingStatus } from '../audit-log/forward';
import { judge, type BackupHealthInput, type ForwardHealthInput, type HealthReport } from './health';
import { renderMetrics } from './metrics';
import { listCertificateExpiries, systemOverview } from './overview';

/** So viele Läufe zurück wird nach dem letzten gelungenen gesehen. */
const BACKUP_WINDOW = 20;

/** Der Stand der Sicherung. `null`: nicht zu lesen, also unbekannt. */
export async function readBackupHealth(): Promise<BackupHealthInput | null> {
  try {
    const [settings, runs] = await Promise.all([getBackupSettings(), listBackupRuns(BACKUP_WINDOW)]);
    const last = runs[0] ?? null;
    const success = runs.find((run) => run.status === 'success' || run.status === 'warning') ?? null;
    return {
      enabled: settings.enabled,
      lastRun: last ? { status: last.status, startedAt: last.startedAt } : null,
      lastSuccessAt: success ? (success.completedAt ?? success.startedAt) : null,
    };
  } catch {
    return null;
  }
}

/** Die Ziele der Weiterleitung des Protokolls. `null`: nicht zu lesen. */
export async function readForwardHealth(): Promise<ForwardHealthInput[] | null> {
  try {
    return (await forwardingStatus()).map(({ destination, enabled, failingSince, backlog }) => ({
      destination,
      enabled,
      failingSince,
      backlog,
    }));
  } catch {
    return null;
  }
}

export async function readHealth(translator: Translator): Promise<HealthReport> {
  const [overview, backup, forwarding] = await Promise.all([systemOverview(), readBackupHealth(), readForwardHealth()]);
  return judge(overview, { backup, forwarding }, translator);
}

/**
 * Die Texte des Urteils kommen in den Metriken nicht vor, nur die Zustände:
 * die Sprache ist deshalb gleich.
 */
export async function readMetrics(translator: Translator): Promise<string> {
  const [overview, backup, forwarding, certificates] = await Promise.all([
    systemOverview(),
    readBackupHealth(),
    readForwardHealth(),
    listCertificateExpiries(),
  ]);
  return renderMetrics({
    overview,
    health: judge(overview, { backup, forwarding }, translator),
    certificates,
    backup,
    forwarding,
  });
}
