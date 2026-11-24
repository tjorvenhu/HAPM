import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { serviceActor } from '@/lib/audit';
import { precheckCreate, probeProxy } from '@/lib/haproxy/provision';
import { startHaproxyRun } from '@/lib/haproxy/runner';
import {
  haproxyActor,
  proxyServers,
  readDnsDomains,
  resolveProxy,
  servicesOf,
  type ServiceView,
} from '@/lib/haproxy/internal';
import { readServiceRequest } from '@/lib/haproxy/password-lock';
import { HaproxyConfigError, validateCreateInput } from '@/lib/haproxy/config';

/**
 * Die Reverse-Proxy-Ziele für einen anderen Dienst: lesen und anlegen.
 *
 * Das Gegenstück zu `/api/haproxy/services`, nur mit Token statt Sitzung. Was
 * dort gilt, gilt hier unverändert — es ist derselbe Rumpf, dieselbe Prüfung,
 * dieselbe Vorabprüfung und derselbe abgekoppelte Lauf. Siehe
 * `lib/haproxy/internal.ts` für den Grund, warum kein zweiter Schreibweg
 * daneben entsteht.
 */

interface ListResponse {
  services: ServiceView[];
  /** Gesetzt, wenn HAProxy gerade nicht antwortet. Eigenes Feld und keine
   *  Ausnahme: eine leere Liste hieße sonst „es gibt keine Dienste" statt
   *  „nicht lesbar", und darauf würde eine Pipeline einen Eintrag anlegen, den
   *  es längst gibt. Eine Liste wie die von `/proxies`. */
  unreachable: { serverId: string; serverName: string; error: string }[];
}

/**
 * Die Einträge, alle oder gefiltert.
 *
 * `?domain=` grenzt auf die Einträge ein, die diese Domain bedienen, `?scope=`
 * auf eine Gruppe. Der Domainfilter ist der eigentliche Zweck: die Frage einer
 * Pipeline vor dem Anlegen ist „gibt es dafür schon etwas?". `?serverId=` wird
 * angenommen und geprüft, ändert bei einer Maschine aber nichts.
 *
 * Ohne Audit-Eintrag, aus demselben Grund wie bei `/proxies`: gelesen wird die
 * Form der Konfiguration, und der Vorgang danach protokolliert sich selbst.
 */
export async function GET(request: Request) {
  try {
    await requireServiceToken(request);

    const url = new URL(request.url);
    const wantedServer = url.searchParams.get('serverId');
    const domain = url.searchParams.get('domain')?.trim().toLowerCase() || null;
    const scope = url.searchParams.get('scope')?.trim().toUpperCase() || null;

    // Eine genannte Maschine geht durch `resolveProxy`, damit eine unbekannte ID
    // ein 404 ist und keine leere Liste — die liest sich wie „es gibt dort
    // keine Einträge".
    const servers = wantedServer
      ? [await resolveProxy(wantedServer)]
      : await proxyServers();

    const response: ListResponse = { services: [], unreachable: [] };

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
          response.services.push(...servicesOf(server, probe));
        } catch (err) {
          response.unreachable.push({
            serverId: server.$id,
            serverName: server.name,
            error: err instanceof Error ? err.message : 'HAProxy ist nicht erreichbar.',
          });
        }
      })
    );

    response.services = response.services.filter((service) => {
      if (scope && (service.scope ?? '').toUpperCase() !== scope) return false;
      // Exakter Vergleich und keine Teilzeichenkette: `kunde.example` bedient nicht
      // `fremdekunde.example`, obwohl der Name darin vorkommt. Wer die Wildcard
      // darüber sucht, fragt nach ihr — dass `*.kunde.example` auch `app.kunde.example`
      // trägt, ist eine Frage an `/proxies` und nicht an einen Textfilter.
      if (domain && !service.domains.some((d) => d.toLowerCase() === domain)) return false;
      return true;
    });

    response.services.sort(
      (a, b) => a.serverName.localeCompare(b.serverName, 'de') || a.id.localeCompare(b.id, 'de')
    );

    return ok(response);
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Ein Ziel anlegen — Dienst-ID, Gruppe, Domains, Ziele, Pfad-Regeln, Preset,
 * Healthcheck, Sperrliste und der DNS-Eintrag dazu.
 *
 * Die Antwort trägt nur die ID des Laufs. Alles, was Zeit kostet — DNS,
 * Zertifikat, `haproxy -c`, Reload — läuft danach weiter und dauert Minuten;
 * eine Route, die darauf wartet, wäre eine Anfrage, die in jedes vernünftige
 * Timeout läuft. Der Aufrufer pollt `/api/internal/haproxy/runs/<id>`, bis
 * `status` nicht mehr `running` ist.
 *
 * Was sich ohne Schreibvorgang beantworten lässt, bleibt trotzdem synchron und
 * kommt als Fehler zurück: belegte Dienst-ID, fremde Domain, fehlendes acme.sh,
 * Wildcard ohne DNS-Hook. Ein Aufruf, der mit einer Lauf-ID antwortet und eine
 * Minute später „Dienst-ID bereits vergeben" in die Historie schreibt, zwingt
 * die Pipeline, den Fehlerfall aus einem Protokolltext zu lesen.
 */
export async function POST(request: Request) {
  try {
    // Kein requireCsrf: ein CSRF-Token schützt einen Browser mit Cookie, und
    // hier gibt es weder das eine noch das andere.
    const service = await requireServiceToken(request);

    const body = await jsonBody<{
      serverId?: string;
      dnsHook?: string;
      dnsDomains?: string[] | 'auto';
    }>(request);

    const server = await resolveProxy(body.serverId);

    // Mit dem Passwort der Sperre, falls eins mitkam (lib/haproxy/password-lock.ts).
    const input = readServiceRequest(body);
    const invalid = validateCreateInput(input);
    if (invalid) throw new ApiError(invalid);

    // Nicht Teil der Eingabe: der Hook steht in keiner Zeile der Konfiguration.
    const dnsHook = String(body.dnsHook ?? '').trim() || null;

    try {
      await precheckCreate(server, input, dnsHook);
    } catch (err) {
      if (err instanceof HaproxyConfigError) throw new ApiError(err.message, 409);
      throw err;
    }

    const run = await startHaproxyRun({
      server,
      action: 'create',
      serviceId: input.id,
      input,
      dnsHook,
      dns: { ensure: await readDnsDomains(body.dnsDomains, input.domains) },
      actor: haproxyActor(serviceActor(service), request),
    });

    return ok({ runId: run.$id, serverId: server.$id, serviceId: input.id });
  } catch (err) {
    return handleError(err);
  }
}
