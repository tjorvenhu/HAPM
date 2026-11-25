import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { getClientIP, serviceActor } from '@/lib/audit';
import { haproxyContainer, restartHaproxy } from '@/lib/system/haproxy-container';

/**
 * Der Container von HAProxy, wie auf der Seite „System": GET mit `?logs=1`
 * samt der letzten 200 Zeilen seiner Ausgabe, POST `{ "action": "restart" }`
 * startet ihn neu. Ein Neustart bricht offene Verbindungen ab; eine geänderte
 * Konfiguration braucht ihn nicht, die lädt jeder Vorgang selbst neu.
 */

export async function GET(request: Request) {
  try {
    await requireServiceToken(request);
    const wantsLogs = new URL(request.url).searchParams.get('logs') === '1';
    return ok(await haproxyContainer({ logs: wantsLogs }));
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(request: Request) {
  try {
    const service = await requireServiceToken(request);
    const body = await jsonBody<{ action?: string }>(request);
    if (body.action !== 'restart') throw new ApiError(msg('Unbekannte Aktion.'));
    return ok(await restartHaproxy({ ...serviceActor(service), ip: getClientIP(request) }));
  } catch (err) {
    return handleError(err);
  }
}
