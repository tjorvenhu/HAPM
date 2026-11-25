import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError } from '@/lib/api';
import { getT } from '@/lib/i18n/server';
import { getRun } from '@/lib/haproxy/api-actions';

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
 *
 * Die Antwort (`phase` nur für eine Anzeige, `log` als Protokolltext) baut
 * `getRun` in `lib/haproxy/api-actions.ts`.
 */
export async function GET(request: Request, { params }: Params) {
  try {
    await requireServiceToken(request);
    const { id } = await params;
    const { t } = await getT();
    return ok(await getRun(id, t));
  } catch (err) {
    return handleError(err);
  }
}
