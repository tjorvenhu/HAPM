import { requireSession, requireCsrf } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { getClientIP } from '@/lib/audit';
import {
  getProxyServer,
  precheckStreamUpdate,
  precheckStreamDelete,
} from '@/lib/haproxy/provision';
import { startHaproxyRun } from '@/lib/haproxy/runner';
import { HaproxyConfigError } from '@/lib/haproxy/config';
import { readStreamInput, validateStreamInput } from '@/lib/haproxy/streams';
import { LOCAL_SERVER_ID } from '@/lib/helpers';

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * Eine TCP-Weiterleitung ändern.
 *
 * Kein PUT, aus demselben Grund wie bei einem Dienst: die `id` im Pfad ist der
 * ALTE Name, der Rumpf trägt schon den neuen — beim Umbenennen zeigen beide auf
 * verschiedene Dinge.
 *
 * Ausgeführt als EIN Schreibvorgang. Zwei Reloads hätten eine Lücke dazwischen,
 * und bei einer durchgereichten Datenbankverbindung heißt das abgebrochene
 * Sitzungen und nicht eine langsame Seite.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const { id } = await params;
    const body = await jsonBody<{ serverId?: string }>(request);

    const server = await getProxyServer(body.serverId || LOCAL_SERVER_ID);

    // Ohne `id` im Rumpf behält der Abschnitt seine Kennung, auch wenn der
    // Port sich ändert: abgeleitet wird sie nur beim Anlegen.
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
      actor: { userId: session.userId, email: session.email, ip: getClientIP(request) },
    });

    return ok({ runId: run.$id });
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Eine TCP-Weiterleitung entfernen.
 *
 * Die `id` im Pfad ist der Name des `listen`-Abschnitts und keine Dokument-ID —
 * es gibt kein Dokument. `serverId` im Rumpf ist freiwillig: ohne sie gilt
 * dieser Server.
 */
export async function DELETE(request: Request, { params }: Params) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const { id } = await params;
    const body = await jsonBody<{ serverId?: string }>(request).catch(
      () => ({}) as { serverId?: string }
    );

    const server = await getProxyServer(body.serverId || LOCAL_SERVER_ID);

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
      actor: { userId: session.userId, email: session.email, ip: getClientIP(request) },
    });

    return ok({ runId: run.$id });
  } catch (err) {
    return handleError(err);
  }
}
