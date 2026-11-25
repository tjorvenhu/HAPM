import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError, jsonBody } from '@/lib/api';
import { serviceActor } from '@/lib/audit';
import { haproxyActor } from '@/lib/haproxy/internal';
import { deleteStreamRun, getStream, updateStreamRun } from '@/lib/haproxy/api-actions';

/**
 * Eine einzelne TCP-Weiterleitung: lesen, ändern, entfernen.
 *
 * Die `id` im Pfad ist der Name des `listen`-Abschnitts aus `haproxy.cfg` und
 * keine Dokument-ID — es gibt kein Dokument, `haproxy.cfg` ist die
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
    return ok(await getStream(id, wantedServer(request)));
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
    const body = await jsonBody(request);
    return ok(
      await updateStreamRun(
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
    return ok(
      await deleteStreamRun(
        id,
        { serverId: wantedServer(request, body) },
        haproxyActor(serviceActor(service), request)
      )
    );
  } catch (err) {
    return handleError(err);
  }
}
