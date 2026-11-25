import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError, jsonBody } from '@/lib/api';
import { getT } from '@/lib/i18n/server';
import { serviceActor } from '@/lib/audit';
import { haproxyActor } from '@/lib/haproxy/internal';
import { checkPort, createStreamRun, listStreams } from '@/lib/haproxy/api-actions';

/**
 * Die TCP-Weiterleitungen für einen anderen Dienst: lesen und anlegen.
 *
 * Das Gegenstück zu `/api/haproxy/streams`, nur mit Token statt Sitzung. Was
 * dort gilt, gilt hier unverändert — derselbe Rumpf (`readStreamInput`),
 * dieselbe Prüfung (`validateNewStream`), dieselbe Vorabprüfung und derselbe
 * abgekoppelte Lauf. Die Logik steht in `lib/haproxy/api-actions.ts`, der
 * MCP-Server ruft sie auch.
 *
 * ── Was ein Aufrufer hier anders machen muss als bei einem Dienst ──
 *
 * Er muss sich den Port aussuchen, und der ist eine Ressource dieses Servers
 * und nicht seine. Deshalb gibt es `?port=` als eigene Frage: `haproxy -c` bindet
 * keine Sockets, ein belegter Port kommt also durch die Prüfung und scheitert
 * erst beim Reload. Wer eine Pipeline baut, fragt vorher.
 */

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
    const { t } = await getT();

    const url = new URL(request.url);
    const serverId = url.searchParams.get('serverId');
    const rawPort = url.searchParams.get('port');

    if (rawPort !== null) {
      return ok(await checkPort(rawPort, { serverId, exclude: url.searchParams.get('exclude') }, t));
    }
    return ok(await listStreams({ serverId, scope: url.searchParams.get('scope') }, t));
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
    const body = await jsonBody(request);
    return ok(await createStreamRun(body, haproxyActor(serviceActor(service), request)));
  } catch (err) {
    return handleError(err);
  }
}
