/**
 * Der Container von HAProxy: Zustand, letzte Ausgabe, Neustart. Die Seite
 * „System", die interne API (`/api/internal/system/haproxy`) und der
 * MCP-Server rufen dieselben Funktionen; die Logik stand vorher in
 * `app/api/system/haproxy/route.ts`.
 *
 * Ein Neustart ist kein Reload: offene Verbindungen brechen ab. Er ist für
 * den Fall, dass HAProxy steht oder hängt, nicht für eine geänderte
 * Konfiguration (die lädt jeder Vorgang selbst neu).
 */

import { ApiError } from '../api';
import { msg } from '../i18n';
import { logAudit } from '../audit';
import { containerInfo, engine, haproxyContainerName, DockerError } from '../docker';

export const HAPROXY_LOG_LINES = 200;

/** Wie lange nach dem Start gewartet wird, bevor der Zustand gelesen wird. */
const SETTLE_MS = 2000;

export interface ContainerActor {
  userId: string;
  userEmail: string;
  ip?: string;
}

function dockerFailure(err: unknown, name: string): ApiError {
  if (err instanceof DockerError && err.status === 404) {
    return new ApiError(msg('Der Container "{name}" existiert nicht.', { name }), 404);
  }
  const detail = err instanceof Error ? err.message : String(err);
  return new ApiError(msg('Docker meldet einen Fehler: {detail}', { detail }), 502);
}

/** Der Container, mit `logs` samt seiner letzten Ausgabe (stdout/stderr, nicht das Zugriffslog). */
export async function haproxyContainer(options: { logs: boolean }) {
  const name = haproxyContainerName();
  try {
    const container = await containerInfo(name);
    if (!options.logs) return { container };
    if (!container) throw new ApiError(msg('Der Container "{name}" existiert nicht.', { name }), 404);
    const logs = await engine.logs(name, { tail: HAPROXY_LOG_LINES });
    return { container, logs, lines: HAPROXY_LOG_LINES };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw dockerFailure(err, name);
  }
}

/** Neu starten (startet auch einen Container, der steht) und danach den Zustand lesen. */
export async function restartHaproxy(actor: ContainerActor) {
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
    ...actor,
    action: 'settings_updated',
    resource: 'haproxy',
    resourceId: name,
    details: `HAProxy ${wasRunning ? 'neu gestartet' : 'gestartet'}${container?.running ? '' : ', läuft danach nicht'}`,
  });

  return { container, wasRunning };
}
