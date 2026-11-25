import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError, jsonBody } from '@/lib/api';
import { getT } from '@/lib/i18n/server';
import { serviceActor } from '@/lib/audit';
import { haproxyActor } from '@/lib/haproxy/internal';
import { createServiceRun, listServices } from '@/lib/haproxy/api-actions';

/**
 * Die Reverse-Proxy-Ziele für einen anderen Dienst: lesen und anlegen.
 *
 * Das Gegenstück zu `/api/haproxy/services`, nur mit Token statt Sitzung. Was
 * dort gilt, gilt hier unverändert — es ist derselbe Rumpf, dieselbe Prüfung,
 * dieselbe Vorabprüfung und derselbe abgekoppelte Lauf. Siehe
 * `lib/haproxy/internal.ts` für den Grund, warum kein zweiter Schreibweg
 * daneben entsteht, und `lib/haproxy/api-actions.ts` für die Logik, die sich
 * diese Route mit dem MCP-Server teilt.
 */

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
    const { t } = await getT();
    const url = new URL(request.url);
    return ok(
      await listServices(
        {
          serverId: url.searchParams.get('serverId'),
          domain: url.searchParams.get('domain'),
          scope: url.searchParams.get('scope'),
        },
        t
      )
    );
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Ein Ziel anlegen — Gruppe, Domains, Ziele, Pfad-Regeln, Header,
 * Healthcheck, Sperrliste und der DNS-Eintrag dazu.
 *
 * `id` ist freiwillig. Fehlt sie, ergibt sie sich aus der Hauptdomain, wie im
 * Dialog (`assignServiceId`), und die Antwort nennt sie als `serviceId`.
 *
 * Die Antwort trägt sonst nur die ID des Laufs. Alles, was Zeit kostet — DNS,
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
    const body = await jsonBody(request);
    return ok(await createServiceRun(body, haproxyActor(serviceActor(service), request)));
  } catch (err) {
    return handleError(err);
  }
}
