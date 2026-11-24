import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { logAudit, getClientIP } from '@/lib/audit';
import { containerInfo, engine, haproxyContainerName, DockerError } from '@/lib/docker';

const LOG_LINES = 200;

/** Wie lange nach dem Start gewartet wird, bevor der Zustand gelesen wird. */
const SETTLE_MS = 2000;

function dockerFailure(err: unknown, name: string): ApiError {
  if (err instanceof DockerError && err.status === 404) {
    return new ApiError(`Der Container "${name}" existiert nicht.`, 404);
  }
  const detail = err instanceof Error ? err.message : String(err);
  return new ApiError(`Docker meldet einen Fehler: ${detail}`, 502);
}

/** Der Container von HAProxy, mit `?logs=1` samt seiner letzten Ausgabe. */
export async function GET(request: Request) {
  try {
    await requireSession();
    const name = haproxyContainerName();
    const wantsLogs = new URL(request.url).searchParams.get('logs') === '1';
    try {
      const container = await containerInfo(name);
      if (!wantsLogs) return ok({ container });
      if (!container) throw new ApiError(`Der Container "${name}" existiert nicht.`, 404);
      const logs = await engine.logs(name, { tail: LOG_LINES });
      return ok({ container, logs, lines: LOG_LINES });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw dockerFailure(err, name);
    }
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody<{ action?: string }>(request);
    if (body.action !== 'restart') throw new ApiError('Unbekannte Aktion.');

    const name = haproxyContainerName();
    let wasRunning = false;
    try {
      wasRunning = Boolean((await containerInfo(name))?.running);
      // `restart` startet auch einen Container, der gerade steht.
      await engine.restart(name);
    } catch (err) {
      throw dockerFailure(err, name);
    }

    // Ein Container, der an seiner Konfiguration scheitert, läuft im ersten Moment trotzdem.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    const container = await containerInfo(name).catch(() => null);

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'settings_updated',
      resource: 'haproxy',
      resourceId: name,
      details: `HAProxy ${wasRunning ? 'neu gestartet' : 'gestartet'}${container?.running ? '' : ', läuft danach nicht'}`,
      ip: getClientIP(request),
    });

    return ok({ container, wasRunning });
  } catch (err) {
    return handleError(err);
  }
}
