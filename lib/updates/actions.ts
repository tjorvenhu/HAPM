/**
 * Was die Seite „Updates", die interne API (`/api/internal/updates`) und der
 * MCP-Server gemeinsam tun: den Stand lesen, prüfen, ein Update starten, einen
 * Lauf lesen.
 *
 * Die Logik stand vorher in `app/api/updates/`. Sie ist hier, damit Route,
 * API und Werkzeug dieselbe Prüfung des Bestandteils und dieselbe Antwort
 * haben (docs/mcp.md, „Keine eigene Logik in den Werkzeugen").
 */

import { getDocument } from '../db';
import { ApiError } from '../api';
import { msg } from '../i18n';
import { getSettings } from '../settings';
import { parseSteps, stepsAsLog } from '../haproxy/runner';
import { COLLECTIONS, type UpdateComponent, type UpdateRun } from '../types';
import { checkUpdates, isCheckRunning, readUpdateStates, settleAfterRuns } from './check';
import { listUpdateRuns, startUpdate, type UpdateActor } from './apply';

export const UPDATE_COMPONENTS: readonly UpdateComponent[] = ['haproxy', 'hapm', 'acme'];

const HISTORY = 30;

/** Die Übersicht der Seite: Stand je Bestandteil, die letzten Läufe, die Schalter. */
export async function updatesOverview() {
  const [states, runs, settings] = await Promise.all([readUpdateStates(), listUpdateRuns(HISTORY), getSettings()]);
  settleAfterRuns(states, runs);
  return {
    states,
    runs: runs.map((run) => ({ ...run, steps: parseSteps(run.steps) })),
    settings: { autoUpdateHaproxy: settings.autoUpdateHaproxy, autoUpdateTime: settings.autoUpdateTime },
    // Aus der Historie und nicht aus dem Prozess: bei der Übergabe von HAPM
    // bleibt der Lauf offen, bis der neue Container ihn schließt.
    running: runs.some((run) => run.status === 'running'),
    checking: isCheckRunning(),
  };
}

export type UpdatesOverview = Awaited<ReturnType<typeof updatesOverview>>;

/** Jetzt prüfen. Fragt die Registries und GitHub, geholt wird nichts. */
export async function checkUpdatesNow(): Promise<UpdatesOverview> {
  await checkUpdates();
  return updatesOverview();
}

/**
 * Ein Update beginnen. Die Antwort trägt nur den Lauf: er läuft abgekoppelt
 * weiter, und das Protokoll schreibt `startUpdate` selbst.
 */
export async function startComponentUpdate(component: unknown, actor: UpdateActor): Promise<{ runId: string }> {
  if (typeof component !== 'string' || !UPDATE_COMPONENTS.includes(component as UpdateComponent)) {
    throw new ApiError(msg('Diesen Bestandteil gibt es nicht.'), 404);
  }
  const run = await startUpdate(component as UpdateComponent, actor);
  return { runId: run.$id };
}

/**
 * Ein Update-Lauf, in der Form von `getRun` (`lib/haproxy/api-actions.ts`):
 * Schritte, dazu Fehler und Protokolltext übersetzt.
 *
 * Bei einem Update von HAPM bleibt der Lauf nach der Übergabe offen, bis der
 * neue Container ihn beim Start schließt (`reconcileUpdateRuns`). Wer hier
 * pollt, sieht also `running`, dann eine Weile keine Antwort, dann den
 * geschlossenen Lauf.
 */
export async function getUpdateRun(id: string, t: (text: string) => string) {
  let run: UpdateRun;
  try {
    run = await getDocument<UpdateRun>(COLLECTIONS.UPDATE_RUNS, id);
  } catch {
    throw new ApiError(msg('Update-Lauf nicht gefunden.'), 404);
  }
  const steps = parseSteps(run.steps);
  return {
    id: run.$id,
    component: run.component,
    status: run.status,
    fromVersion: run.fromVersion,
    toVersion: run.toVersion,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    triggeredBy: run.triggeredBy,
    error: run.error === null ? null : t(run.error),
    steps,
    log: stepsAsLog(steps, t),
  };
}

export type UpdateRunView = Awaited<ReturnType<typeof getUpdateRun>>;
