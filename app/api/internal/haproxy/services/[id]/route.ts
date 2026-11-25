import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError, jsonBody } from '@/lib/api';
import { serviceActor } from '@/lib/audit';
import { haproxyActor } from '@/lib/haproxy/internal';
import { deleteServiceRun, getService, updateServiceRun } from '@/lib/haproxy/api-actions';

/**
 * Ein einzelnes Reverse-Proxy-Ziel: lesen, ändern, entfernen.
 *
 * Die `id` im Pfad ist der Backend-Name aus `haproxy.cfg` und keine
 * Dokument-ID — es gibt kein Dokument, `haproxy.cfg` ist die
 * Wahrheit. `serverId` darf fehlen, und dann gilt dieser Server.
 *
 * Die Logik steht in `lib/haproxy/api-actions.ts`, der MCP-Server ruft sie auch.
 */

interface Params {
  params: Promise<{ id: string }>;
}

/** Wo `serverId` steht: im Rumpf, wenn es einen gibt, sonst in der Adresse. */
function wantedServer(request: Request, body?: { serverId?: unknown }): string | null {
  const fromBody = body?.serverId;
  if (fromBody !== undefined && fromBody !== null) return String(fromBody);
  return new URL(request.url).searchParams.get('serverId');
}

export async function GET(request: Request, { params }: Params) {
  try {
    await requireServiceToken(request);
    const { id } = await params;
    return ok(await getService(id, wantedServer(request)));
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Ein Ziel ändern.
 *
 * Kein PUT: der Rumpf beschreibt den Dienst vollständig, aber die `id` im Pfad
 * ist der ALTE Name — beim Umbenennen zeigen Pfad und Rumpf auf verschiedene
 * Dinge, und genau das kann PUT nicht bedeuten.
 *
 * **Der Rumpf ist vollständig, nicht teilweise.** Wer nur die Backend-Adresse
 * schickt, bekommt einen Eintrag ohne Domains — und die Prüfung lehnt ihn ab.
 * Das ist Absicht: ein Eintrag entsteht hier aus EINEM Text, der in EINEM
 * `haproxy -c` geprüft und mit EINEM Reload gültig wird, und ein Zusammenbauen
 * aus „alt plus die Felder, die dastanden" hieße, zwischen Lesen und Schreiben
 * den Stand von vorhin festzuhalten. Der Weg dahin ist GET, ändern, PATCH — und
 * `editable: false` aus dem GET sagt vorher, dass es gar nicht geht.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const service = await requireServiceToken(request);
    const { id } = await params;
    const body = await jsonBody(request);
    return ok(
      await updateServiceRun(
        id,
        { ...body, serverId: wantedServer(request, body) },
        haproxyActor(serviceActor(service), request)
      )
    );
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Ein Ziel entfernen.
 *
 * `removeDns` fehlt heißt: die DNS-Einträge bleiben stehen. Der Dialog belegt
 * den Haken mit „ja" vor, weil ein Mensch ihn dort sieht und abwählen kann; ein
 * Aufruf ohne das Feld hat dagegen nichts gesagt, und ein Löschvorgang, der
 * stillschweigend auch die Zone anfasst, ist genau die Nebenwirkung, die man
 * einem Werkzeug später nicht mehr ansieht. Entfernt wird ohnehin nur, was
 * dieses Werkzeug selbst gesetzt hat.
 */
export async function DELETE(request: Request, { params }: Params) {
  try {
    const service = await requireServiceToken(request);
    const { id } = await params;

    // Ein DELETE ohne Rumpf ist zulässig, und dann gilt die Vorgabe: kein DNS,
    // und die Maschine kommt aus der Adresse.
    const body = await jsonBody<{ serverId?: string; removeDns?: boolean }>(request).catch(
      () => ({}) as { serverId?: string; removeDns?: boolean }
    );

    return ok(
      await deleteServiceRun(
        id,
        { serverId: wantedServer(request, body), removeDns: body.removeDns === true },
        haproxyActor(serviceActor(service), request)
      )
    );
  } catch (err) {
    return handleError(err);
  }
}
