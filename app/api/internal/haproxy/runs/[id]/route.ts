import { requireServiceToken } from '@/lib/service-auth';
import { getDocument } from '@/lib/db';
import { COLLECTIONS } from '@/lib/types';
import { ok, handleError, ApiError } from '@/lib/api';
import { parseSteps, stepsAsLog } from '@/lib/haproxy/runner';
import type { HaproxyRun } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

/**
 * Der Stand eines Reverse-Proxy-Vorgangs — der Endpunkt, ohne den die
 * schreibenden Routen unbrauchbar wären.
 *
 * Anlegen, Ändern und Löschen antworten mit einer Lauf-ID und nicht mit dem
 * Ergebnis: DNS, Zertifikat, `haproxy -c` und Reload dauern Minuten. Der
 * Aufrufer pollt hier, bis `status` nicht mehr `running` ist, und liest dann
 * `steps` — jeder Schritt mit `ok` und Begründung.
 *
 * **`status: 'error'` heißt nicht, dass nichts passiert ist.** Der Vorgang
 * besteht aus mehreren Teilen, und ein Abbruch im vierten kann ein
 * ausgestelltes Zertifikat und einen gesetzten DNS-Eintrag hinterlassen haben.
 * Was durchkam, sagen die Schritte; zurückgerollt wird auf Verdacht nichts,
 * denn das nähme auf einem Reverse-Proxy fremde Domains offline.
 *
 * Ohne Audit-Eintrag, und hier ist der Grund handfest: ein Aufrufer, der im
 * Zwei-Sekunden-Takt pollt, schriebe neunzig Zeilen je Provisionierung. Ein
 * Protokoll, in dem die Vorgänge zwischen ihren eigenen Abfragen untergehen,
 * beantwortet die Frage nicht mehr, für die es da ist. Der Vorgang selbst steht
 * darin, mit dem Namen des Dienstes.
 */
export async function GET(request: Request, { params }: Params) {
  try {
    await requireServiceToken(request);
    const { id } = await params;

    let run: HaproxyRun;
    try {
      run = await getDocument<HaproxyRun>(COLLECTIONS.HAPROXY_RUNS, id);
    } catch {
      throw new ApiError('Reverse-Proxy-Vorgang nicht gefunden.', 404);
    }

    const steps = parseSteps(run.steps);

    return ok({
      id: run.$id,
      serverId: run.serverId,
      serverName: run.serverName,
      action: run.action,
      serviceId: run.serviceId,
      /** Gesetzt, wenn der Vorgang den Eintrag umbenannt hat. */
      renamedTo: run.renamedTo,
      status: run.status,
      /** Wo er gerade steht: preflight, dns, certificate, checking, installing,
       *  cleanup, done. Für eine Anzeige beim Aufrufer, nicht für eine
       *  Entscheidung — die trifft `status`. */
      phase: run.phase,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      duration: run.duration,
      error: run.error,
      steps,
      /** Dieselben Schritte als Protokolltext, für ein Log auf der Gegenseite. */
      log: stepsAsLog(steps),
    });
  } catch (err) {
    return handleError(err);
  }
}
