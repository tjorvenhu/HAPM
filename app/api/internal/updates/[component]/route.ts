import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError } from '@/lib/api';
import { getClientIP, serviceActor } from '@/lib/audit';
import { startComponentUpdate } from '@/lib/updates/actions';

/**
 * Ein Update beginnen: `haproxy`, `hapm` oder `acme`. Dieselbe Funktion wie
 * der Knopf auf der Seite „Updates", also dieselben Regeln: immer nur ein
 * Update, HAProxy erst nach `haproxy -c` mit dem neuen Abbild, der alte
 * Container kommt zurück, wenn der neue nicht steht.
 *
 * Die Antwort trägt nur `runId`, der Lauf läuft abgekoppelt. Ein Update von
 * HAPM ersetzt den Container, der diese Anfrage beantwortet: die API ist dann
 * etwa eine Minute nicht erreichbar, und den Lauf schließt der neue Container
 * beim Start. Danach `GET ./runs/{runId}`.
 */
export async function POST(request: Request, { params }: { params: Promise<{ component: string }> }) {
  try {
    const service = await requireServiceToken(request);
    const { component } = await params;
    return ok(await startComponentUpdate(component, { ...serviceActor(service), ip: getClientIP(request) }));
  } catch (err) {
    return handleError(err);
  }
}
