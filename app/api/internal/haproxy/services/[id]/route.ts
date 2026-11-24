import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { serviceActor } from '@/lib/audit';
import { precheckDelete, precheckUpdate, probeProxy } from '@/lib/haproxy/provision';
import { startHaproxyRun } from '@/lib/haproxy/runner';
import { getSettings } from '@/lib/settings';
import {
  haproxyActor,
  readDnsDomains,
  resolveProxy,
  serviceView,
} from '@/lib/haproxy/internal';
import { readServiceRequest } from '@/lib/haproxy/password-lock';
import { HaproxyConfigError, serviceHealth, validateCreateInput } from '@/lib/haproxy/config';
import { surfaceTarget } from '@/lib/haproxy/protected';

/**
 * Ein einzelnes Reverse-Proxy-Ziel: lesen, ändern, entfernen.
 *
 * Die `id` im Pfad ist der Backend-Name aus `haproxy.cfg` und keine
 * Dokument-ID — es gibt kein Dokument, `haproxy.cfg` ist die
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

    const service = probe.services.find((entry) => entry.id === id);
    if (!service) {
      throw new ApiError(`Auf "${server.name}" gibt es kein Ziel mit der ID "${id}".`, 404);
    }

    const surface = surfaceTarget(probe.services, { publicUrl: (await getSettings()).publicUrl });
    return ok(serviceView(server, service, serviceHealth(service, probe.serverStates), surface));
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

    const body = await jsonBody<{
      serverId?: string;
      dnsHook?: string;
      dnsDomains?: string[] | 'auto';
    }>(request);

    const server = await resolveProxy(wantedServer(request, body));

    // Mit dem Passwort der Sperre, falls eins mitkam (lib/haproxy/password-lock.ts).
    // Ohne `id` im Rumpf behält der Eintrag seine. Abgeleitet wird sie nur
    // beim Anlegen: hier hieße eine neue ID, ACL und Backend umzubenennen.
    const sent = readServiceRequest(body);
    const input = sent.id === '' ? { ...sent, id } : sent;
    const invalid = validateCreateInput(input);
    if (invalid) throw new ApiError(invalid);

    const dnsHook = String(body.dnsHook ?? '').trim() || null;
    // Intern oder öffentlich: davon hängt ab, ob HTTP-01 überhaupt geht (`challenge.ts`).
    const settings = await getSettings();
    const challenge = { exposure: settings.exposure, dnsHook };
    // Das Ziel, über das die Oberfläche läuft, behält deren Domain (`protected.ts`).
    const protection = { publicUrl: settings.publicUrl };

    let current;
    try {
      current = await precheckUpdate(server, id, input, challenge, protection);
    } catch (err) {
      if (err instanceof HaproxyConfigError) throw new ApiError(err.message, 409);
      throw err;
    }

    // Was aus der Domainliste herausfällt, verliert auch seinen DNS-Eintrag —
    // aber nur, wenn es unserer ist. Der Vergleich muss VOR dem Schreiben
    // passieren: danach steht in der Konfiguration nur noch die neue Liste.
    const kept = new Set(input.domains.map((d) => d.toLowerCase()));
    const dropped = current.domains.filter((domain) => !kept.has(domain.toLowerCase()));

    const run = await startHaproxyRun({
      server,
      action: 'update',
      serviceId: id,
      input,
      challenge,
      protection,
      dns: {
        ensure: await readDnsDomains(body.dnsDomains, input.domains),
        remove: dropped,
      },
      actor: haproxyActor(serviceActor(service), request),
    });

    return ok({ runId: run.$id, serverId: server.$id, serviceId: input.id });
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

    const server = await resolveProxy(wantedServer(request, body));
    // Das Ziel, über das die Oberfläche läuft, bleibt stehen (`protected.ts`).
    const protection = { publicUrl: (await getSettings()).publicUrl };

    // Liest den Dienst, wie er JETZT dasteht: Domains und Ziele gehen
    // denormalisiert in die Historie, danach gibt es sie nirgends mehr.
    let current;
    try {
      current = await precheckDelete(server, id, protection);
    } catch (err) {
      if (err instanceof HaproxyConfigError) throw new ApiError(err.message, 409);
      throw err;
    }

    const run = await startHaproxyRun({
      server,
      action: 'delete',
      serviceId: id,
      service: current,
      protection,
      dns: { remove: body.removeDns === true ? current.domains : [] },
      actor: haproxyActor(serviceActor(service), request),
    });

    return ok({ runId: run.$id, serverId: server.$id, serviceId: id });
  } catch (err) {
    return handleError(err);
  }
}
