import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError } from '@/lib/api';
import { getSettings } from '@/lib/settings';
import { checkUpdates, readUpdateStates } from '@/lib/updates/check';
import { listUpdateRuns } from '@/lib/updates/apply';
import { parseSteps } from '@/lib/haproxy/runner';

const HISTORY = 30;

async function overview() {
  const [states, runs, settings] = await Promise.all([readUpdateStates(), listUpdateRuns(HISTORY), getSettings()]);
  return {
    states,
    runs: runs.map((run) => ({ ...run, steps: parseSteps(run.steps) })),
    settings: { autoUpdateHaproxy: settings.autoUpdateHaproxy, autoUpdateTime: settings.autoUpdateTime },
    // Aus der Historie und nicht aus dem Prozess: bei der Übergabe von HAPM
    // bleibt der Lauf offen, bis der neue Container ihn schließt.
    running: runs.some((run) => run.status === 'running'),
  };
}

export async function GET() {
  try {
    await requireSession();
    return ok(await overview());
  } catch (err) {
    return handleError(err);
  }
}

/** Jetzt prüfen. Fragt die Registries und GitHub, geholt wird nichts. */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    await requireSession();
    await checkUpdates();
    return ok(await overview());
  } catch (err) {
    return handleError(err);
  }
}
