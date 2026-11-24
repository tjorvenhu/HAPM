import { requireSession, requireCsrf } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { getT } from '@/lib/i18n/server';
import { getClientIP } from '@/lib/audit';
import { getProxyServer, precheckStreamCreate, checkStreamPort } from '@/lib/haproxy/provision';
import { startHaproxyRun } from '@/lib/haproxy/runner';
import { HaproxyConfigError } from '@/lib/haproxy/config';
import { readStreamInput, validateNewStream } from '@/lib/haproxy/streams';
import { LOCAL_SERVER_ID } from '@/lib/helpers';

/**
 * TCP-Weiterleitungen: ein Port dieses Servers, durchgereicht an ein Ziel
 * dahinter.
 *
 * Eine eigene Route und kein Zweig in `/api/haproxy/services`, weil es eine
 * andere Sorte Eintrag ist: keine Domain, kein Zertifikat, kein DNS, keine
 * Sperre über die Admin-IPs — dafür ein Port, der auf der Maschine frei sein
 * muss. Ein gemeinsamer Handler wäre an jeder dieser Stellen ein `if`.
 *
 * GELESEN werden sie dagegen zusammen mit den Diensten (`/api/haproxy/services`
 * liefert beide): es ist dieselbe Datei und dieselbe Runde Kommandos, und eine
 * zweite Runde für eine Frage, die die erste schon bezahlt hat, wäre
 * verschenkt.
 */

/**
 * Ob dieser Port auf der Maschine noch frei ist — für das Formular, während
 * jemand tippt.
 *
 * Ein GET und keine Prüfung im Browser: die Antwort steht auf der Maschine.
 * `haproxy -c` sieht einen doppelten Port NICHT (es bindet keine Sockets), also
 * fiele er sonst erst beim Reload auf, und dann ist die Konfiguration schon
 * eingesetzt.
 */
export async function GET(request: Request) {
  try {
    await requireSession();
    const url = new URL(request.url);

    const serverId = url.searchParams.get('serverId') || LOCAL_SERVER_ID;

    const port = Number(url.searchParams.get('port'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ApiError(msg('Der Port muss eine ganze Zahl zwischen {min} und {max} sein.', { min: 1, max: 65535 }));
    }

    // Beim Bearbeiten der eigene Abschnitt: ohne ihn meldete jede Änderung, die
    // den Port behält, einen Konflikt mit sich selbst.
    const exclude = url.searchParams.get('exclude')?.trim() || undefined;

    const server = await getProxyServer(serverId);
    const { t } = await getT();
    return ok(await checkStreamPort(server, port, exclude, t));
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Eine TCP-Weiterleitung anlegen.
 *
 * Wie beim Dienst antwortet die Route mit der Lauf-ID: geprüft, eingesetzt und
 * neu geladen wird abgekoppelt (lib/haproxy/runner.ts). Was sich ohne
 * Schreibvorgang beantworten lässt — belegter Name, belegter Port — bleibt
 * synchron und gehört ins Formular zurück statt in die Historie.
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody<{ serverId?: string }>(request);

    const server = await getProxyServer(body.serverId || LOCAL_SERVER_ID);

    const draft = readStreamInput(body);
    // Dieselbe Funktion wie im Formular. Zwei Regelwerke wären ein Dialog, der
    // etwas durchlässt, was die Route danach ablehnt.
    const invalid = validateNewStream(draft);
    if (invalid) throw new ApiError(invalid);

    // Die Kennung schickt das Formular nicht mit: sie ergibt sich aus dem Port
    // und wird hier vergeben, wo die Datei vorliegt.
    let input;
    try {
      input = await precheckStreamCreate(server, draft);
    } catch (err) {
      if (err instanceof HaproxyConfigError) throw new ApiError(err, 409);
      throw err;
    }

    const run = await startHaproxyRun({
      server,
      action: 'stream-create',
      serviceId: input.id,
      streamInput: input,
      actor: { userId: session.userId, email: session.email, ip: getClientIP(request) },
    });

    return ok({ runId: run.$id, serviceId: input.id });
  } catch (err) {
    return handleError(err);
  }
}
