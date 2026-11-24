import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { serviceActor } from '@/lib/audit';
import {
  precheckStreamUpdate,
  precheckStreamDelete,
  probeProxy,
} from '@/lib/haproxy/provision';
import { startHaproxyRun } from '@/lib/haproxy/runner';
import { haproxyActor, resolveProxy, streamView } from '@/lib/haproxy/internal';
import { HaproxyConfigError, serviceHealth } from '@/lib/haproxy/config';
import { readStreamInput, validateStreamInput } from '@/lib/haproxy/streams';

/**
 * Eine einzelne TCP-Weiterleitung: lesen, ändern, entfernen.
 *
 * Die `id` im Pfad ist der Name des `listen`-Abschnitts aus `haproxy.cfg` und
 * keine Dokument-ID — es gibt kein Dokument, `haproxy.cfg` ist die
 * Wahrheit. `serverId` darf fehlen, und dann gilt dieser Server.
 */

interface Params {
  params: Promise<{ id: string }>;
}

/** Wo `serverId` steht: im Rumpf, wenn es einen gibt, sonst in der Adresse. */
function wantedServer(request: Request, body?: { serverId?: string }): string | null {
  return body?.serverId ?? new URL(request.url).searchParams.get('serverId');
}

export async function GET(request: Request, { params }: Params) {
  try {
    await requireServiceToken(request);
    const { id } = await params;

    const server = await resolveProxy(wantedServer(request));
    const probe = await probeProxy(server);
    if (!probe.configReadable) {
      throw new ApiError(`Die HAProxy-Konfiguration auf "${server.name}" ist nicht lesbar.`, 502);
    }

    const stream = probe.streams.find((entry) => entry.id === id);
    if (!stream) {
      throw new ApiError(
        `Auf "${server.name}" gibt es keine TCP-Weiterleitung mit der Kennung "${id}".`,
        404
      );
    }

    // Ein `listen`-Abschnitt taucht in `show stat` unter seinem Namen auf wie
    // jedes Backend, hat aber keine Pfad-Regeln.
    return ok(
      streamView(server, stream, serviceHealth({ id: stream.id, routes: [] }, probe.serverStates))
    );
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Eine TCP-Weiterleitung ändern.
 *
 * Kein PUT, aus demselben Grund wie beim Dienst: die `id` im Pfad ist der ALTE
 * Name, der Rumpf trägt schon den neuen.
 *
 * **Der Rumpf ist vollständig, nicht teilweise.** Wer nur den Port schickt,
 * bekommt einen Abschnitt ohne Ziele — und die Prüfung lehnt ihn ab. Das ist
 * Absicht und dieselbe Regel wie bei den Diensten: der Abschnitt entsteht aus
 * EINEM Text, der in EINEM `haproxy -c` geprüft und mit EINEM Reload gültig
 * wird. Der Weg ist GET, ändern, PATCH — und `editable: false` aus dem GET sagt
 * vorher, dass es gar nicht geht.
 *
 * Insbesondere gilt das für `allowedSources`: das Feld wegzulassen heißt „von
 * überall erreichbar" und nicht „lass die Liste, wie sie war". Ein PATCH, der
 * eine Absenderliste stillschweigend erbt, wäre genau der, nach dem niemand
 * mehr sagen kann, warum ein Port offen ist.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const service = await requireServiceToken(request);
    const { id } = await params;

    const body = await jsonBody<{ serverId?: string }>(request);
    const server = await resolveProxy(wantedServer(request, body));

    // Ohne `id` im Rumpf behält der Abschnitt seine Kennung.
    const sent = readStreamInput(body);
    const input = sent.id === '' ? { ...sent, id } : sent;
    const invalid = validateStreamInput(input);
    if (invalid) throw new ApiError(invalid);

    try {
      await precheckStreamUpdate(server, id, input);
    } catch (err) {
      if (err instanceof HaproxyConfigError) throw new ApiError(err.message, 409);
      throw err;
    }

    const run = await startHaproxyRun({
      server,
      action: 'stream-update',
      serviceId: id,
      streamInput: input,
      actor: haproxyActor(serviceActor(service), request),
    });

    return ok({ runId: run.$id, serverId: server.$id, streamId: input.id });
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Eine TCP-Weiterleitung entfernen.
 *
 * Kein DNS-Schalter wie beim Dienst: es gibt keinen Eintrag, der dazugehören
 * könnte. Der Port nimmt danach keine Verbindungen mehr an, und was gerade
 * darüber läuft, bricht ab.
 */
export async function DELETE(request: Request, { params }: Params) {
  try {
    const service = await requireServiceToken(request);
    const { id } = await params;

    // Ein DELETE ohne Rumpf ist zulässig; die Maschine kommt dann aus der Adresse.
    const body = await jsonBody<{ serverId?: string }>(request).catch(
      () => ({}) as { serverId?: string }
    );
    const server = await resolveProxy(wantedServer(request, body));

    // Liest den Abschnitt, wie er JETZT dasteht: Port und Ziele gehen
    // denormalisiert in die Historie, danach gibt es sie nirgends mehr.
    let stream;
    try {
      stream = await precheckStreamDelete(server, id);
    } catch (err) {
      if (err instanceof HaproxyConfigError) throw new ApiError(err.message, 409);
      throw err;
    }

    const run = await startHaproxyRun({
      server,
      action: 'stream-delete',
      serviceId: id,
      stream,
      actor: haproxyActor(serviceActor(service), request),
    });

    return ok({ runId: run.$id, serverId: server.$id, streamId: id });
  } catch (err) {
    return handleError(err);
  }
}
