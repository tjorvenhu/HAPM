import { requireSession, requireCsrf } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { getClientIP } from '@/lib/audit';
import {
  getProxyServer,
  precheckDelete,
  precheckUpdate,
} from '@/lib/haproxy/provision';
import { startHaproxyRun } from '@/lib/haproxy/runner';
import { getSettings } from '@/lib/settings';
import { selectedDnsDomains } from '@/lib/dns/zones';
import { readServiceRequest } from '@/lib/haproxy/password-lock';
import { HaproxyConfigError, validateCreateInput } from '@/lib/haproxy/config';
import { LOCAL_SERVER_ID } from '@/lib/helpers';

interface Params {
  params: Promise<{ id: string }>;
}

interface DeleteBody {
  serverId?: string;
  /**
   * Ob die DNS-Einträge dieser Domains mitgehen. Der Dialog fragt das und setzt
   * den Schalter vorbelegt auf an, bietet ihn aber nur an, wenn es überhaupt
   * einen eigenen Eintrag gibt.
   *
   * Fehlt das Feld, wird nichts entfernt. Ein Löschvorgang, der bei einem
   * Aufrufer ohne diese Angabe stillschweigend auch DNS anfasst, wäre genau die
   * Nebenwirkung, die man einem Werkzeug später nicht mehr ansieht.
   */
  removeDns?: boolean;
}

/**
 * Ein Ziel ändern.
 *
 * Kein PUT: der Rumpf beschreibt den Dienst vollständig, aber die `id` im Pfad
 * ist der ALTE Name — beim Umbenennen zeigen Pfad und Rumpf auf verschiedene
 * Dinge, und genau das kann PUT nicht bedeuten.
 *
 * Ausgeführt wird es als EIN Schreibvorgang: neue Konfiguration bauen, prüfen,
 * einsetzen, einmal reloaden. Löschen und neu anlegen wären zwei Reloads mit
 * einer Lücke dazwischen, in der die Domain nicht erreichbar ist.
 *
 * Wie beim Anlegen antwortet die Route mit der Lauf-ID und nicht mit dem
 * Ergebnis: der Vorgang läuft abgekoppelt weiter (lib/haproxy/runner.ts).
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const { id } = await params;
    const body = await jsonBody<{
      serverId?: string;
      dnsHook?: string;
      dnsDomains?: string[];
    }>(request);

    const server = await getProxyServer(body.serverId || LOCAL_SERVER_ID);

    // Mit dem Passwort der Sperre, falls eins mitkam (lib/haproxy/password-lock.ts).
    // Ohne `id` im Rumpf behält der Eintrag seine: sie ergibt sich nur beim
    // Anlegen aus der Domain und ändert sich danach nicht von selbst.
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
        ensure: selectedDnsDomains(body.dnsDomains, input.domains),
        remove: dropped,
      },
      actor: { userId: session.userId, email: session.email, ip: getClientIP(request) },
    });

    return ok({ runId: run.$id });
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Ein Ziel entfernen.
 *
 * Die `id` im Pfad ist der Backend-Name aus der Konfiguration und keine
 * Dokument-ID — es gibt kein Dokument. `serverId` im Rumpf ist freiwillig: ohne
 * sie gilt dieser Server.
 *
 * Der Rumpf geht per DELETE mit Body statt als Query-Parameter.
 */
export async function DELETE(request: Request, { params }: Params) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const { id } = await params;
    const body = await jsonBody<DeleteBody>(request).catch(() => ({}) as DeleteBody);

    const server = await getProxyServer(body.serverId || LOCAL_SERVER_ID);
    // Das Ziel, über das die Oberfläche läuft, bleibt stehen (`protected.ts`).
    const protection = { publicUrl: (await getSettings()).publicUrl };

    // Liest den Dienst, wie er JETZT dasteht: Domains und Ziele gehen
    // denormalisiert in die Historie, danach gibt es sie nirgends mehr.
    let service;
    try {
      service = await precheckDelete(server, id, protection);
    } catch (err) {
      if (err instanceof HaproxyConfigError) throw new ApiError(err.message, 409);
      throw err;
    }

    const run = await startHaproxyRun({
      server,
      action: 'delete',
      serviceId: id,
      service,
      protection,
      // Alle Domains des Dienstes: entfernt wird davon nur, was dieses Werkzeug
      // selbst gesetzt hat — ein A-Eintrag von Hand bleibt stehen und sagt das
      // als Schritt (lib/dns/sync.ts).
      dns: { remove: body.removeDns === true ? service.domains : [] },
      actor: { userId: session.userId, email: session.email, ip: getClientIP(request) },
    });

    return ok({ runId: run.$id });
  } catch (err) {
    return handleError(err);
  }
}
