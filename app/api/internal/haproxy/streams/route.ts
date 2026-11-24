import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { serviceActor } from '@/lib/audit';
import { precheckStreamCreate, probeProxy, checkStreamPort } from '@/lib/haproxy/provision';
import { startHaproxyRun } from '@/lib/haproxy/runner';
import {
  haproxyActor,
  proxyServers,
  resolveProxy,
  streamsOf,
  type StreamView,
} from '@/lib/haproxy/internal';
import { HaproxyConfigError } from '@/lib/haproxy/config';
import { readStreamInput, validateNewStream } from '@/lib/haproxy/streams';

/**
 * Die TCP-Weiterleitungen für einen anderen Dienst: lesen und anlegen.
 *
 * Das Gegenstück zu `/api/haproxy/streams`, nur mit Token statt Sitzung. Was
 * dort gilt, gilt hier unverändert — derselbe Rumpf (`readStreamInput`),
 * dieselbe Prüfung (`validateNewStream`), dieselbe Vorabprüfung und derselbe
 * abgekoppelte Lauf. Siehe `lib/haproxy/internal.ts` für den Grund, warum kein
 * zweiter Schreibweg daneben entsteht.
 *
 * ── Was ein Aufrufer hier anders machen muss als bei einem Dienst ──
 *
 * Er muss sich den Port aussuchen, und der ist eine Ressource dieses Servers
 * und nicht seine. Deshalb gibt es `?port=` als eigene Frage: `haproxy -c` bindet
 * keine Sockets, ein belegter Port kommt also durch die Prüfung und scheitert
 * erst beim Reload. Wer eine Pipeline baut, fragt vorher.
 */

interface ListResponse {
  streams: StreamView[];
  /** Gesetzt, wenn HAProxy gerade nicht antwortet. Eigenes Feld und keine
   *  Ausnahme: eine leere Liste hieße sonst „es gibt keine Weiterleitungen"
   *  statt „nicht lesbar", und darauf würde eine Pipeline einen Port vergeben,
   *  den es längst gibt. Eine Liste wie die von `/proxies`. */
  unreachable: { serverId: string; serverName: string; error: string }[];
}

/**
 * Die Weiterleitungen, alle oder gefiltert.
 *
 * `?scope=` grenzt auf eine Gruppe ein, `?port=` beantwortet die andere Frage:
 * ist dieser Port noch frei. Beides in einer Route, weil es dieselbe Sache aus
 * zwei Richtungen ist — was steht da, und passt das, was ich vorhabe, noch
 * dazu. `?serverId=` wird angenommen und geprüft, ändert bei einer Maschine
 * aber nichts.
 */
export async function GET(request: Request) {
  try {
    await requireServiceToken(request);

    const url = new URL(request.url);
    const wantedServer = url.searchParams.get('serverId');
    const scope = url.searchParams.get('scope')?.trim().toUpperCase() || null;
    const rawPort = url.searchParams.get('port');

    if (rawPort !== null) {
      const port = Number(rawPort.trim());
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new ApiError('port muss eine ganze Zahl zwischen 1 und 65535 sein.');
      }
      const server = await resolveProxy(wantedServer);
      const exclude = url.searchParams.get('exclude')?.trim() || undefined;
      return ok({
        serverId: server.$id,
        serverName: server.name,
        port,
        ...(await checkStreamPort(server, port, exclude)),
      });
    }

    // Eine genannte Maschine geht durch `resolveProxy`, damit eine unbekannte ID
    // ein 404 ist und keine leere Liste.
    const servers = wantedServer ? [await resolveProxy(wantedServer)] : await proxyServers();

    const response: ListResponse = { streams: [], unreachable: [] };

    await Promise.all(
      servers.map(async (server) => {
        try {
          const probe = await probeProxy(server);
          if (!probe.configReadable) {
            response.unreachable.push({
              serverId: server.$id,
              serverName: server.name,
              error: 'Die HAProxy-Konfiguration ist nicht lesbar.',
            });
            return;
          }
          response.streams.push(...streamsOf(server, probe));
        } catch (err) {
          response.unreachable.push({
            serverId: server.$id,
            serverName: server.name,
            error: err instanceof Error ? err.message : 'HAProxy ist nicht erreichbar.',
          });
        }
      })
    );

    if (scope) {
      response.streams = response.streams.filter((s) => (s.scope ?? '').toUpperCase() === scope);
    }
    response.streams.sort(
      (a, b) => a.serverName.localeCompare(b.serverName, 'de') || a.id.localeCompare(b.id, 'de')
    );

    return ok(response);
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Eine TCP-Weiterleitung anlegen.
 *
 * `id` ist freiwillig. Fehlt sie, ergibt sie sich aus dem Port (`tcp_5432`,
 * `assignStreamId`), und die Antwort nennt sie als `streamId`.
 *
 * Die Antwort trägt sonst nur die ID des Laufs; geprüft, eingesetzt und neu geladen
 * wird abgekoppelt. Der Aufrufer pollt `/api/internal/haproxy/runs/<id>`.
 *
 * Was sich ohne Schreibvorgang beantworten lässt, kommt synchron als Fehler
 * zurück: belegter Name, belegter Port in der Konfiguration, belegter Port auf
 * der Maschine. Der letzte ist der Grund, aus dem es diese Prüfung überhaupt
 * gibt — er fiele sonst erst beim Reload auf.
 *
 * **Ohne `allowedSources` ist der Port von überall erreichbar.** Das Feld
 * wegzulassen ist erlaubt und heißt genau das; ein erzwungener Wert wäre eine
 * Entscheidung, die HAPM für einen Aufrufer trifft, der seine Lage
 * besser kennt. In der Historie steht deshalb, welche der beiden Formen es war.
 */
export async function POST(request: Request) {
  try {
    // Kein requireCsrf: ein CSRF-Token schützt einen Browser mit Cookie, und
    // hier gibt es weder das eine noch das andere.
    const service = await requireServiceToken(request);

    const body = await jsonBody<{ serverId?: string }>(request);
    const server = await resolveProxy(body.serverId);

    const draft = readStreamInput(body);
    const invalid = validateNewStream(draft);
    if (invalid) throw new ApiError(invalid);

    let input;
    try {
      input = await precheckStreamCreate(server, draft);
    } catch (err) {
      if (err instanceof HaproxyConfigError) throw new ApiError(err.message, 409);
      throw err;
    }

    const run = await startHaproxyRun({
      server,
      action: 'stream-create',
      serviceId: input.id,
      streamInput: input,
      actor: haproxyActor(serviceActor(service), request),
    });

    return ok({ runId: run.$id, serverId: server.$id, streamId: input.id });
  } catch (err) {
    return handleError(err);
  }
}
