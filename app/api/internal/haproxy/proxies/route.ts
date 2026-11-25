import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError } from '@/lib/api';
import { getT } from '@/lib/i18n/server';
import { listProxies } from '@/lib/haproxy/api-actions';

/**
 * Dieser Server, als Liste mit genau einem Eintrag: der Aufruf, mit dem eine
 * Pipeline anfängt.
 *
 * Ein Aufrufer liest `[0].id` (immer `local`) und darf `serverId` danach
 * mitschicken oder weglassen.
 *
 * Zwei Dinge braucht er, bevor er einen Eintrag anlegen kann, und keins davon
 * kann er erraten: die Gruppen aus den Marker-Blöcken (`scope` ist beim Anlegen
 * Pflicht und steht in der Datei) und die Auskunft, ob acme.sh eingerichtet
 * ist. Ein `acmeReady: false` erst im Lauf zu bemerken heißt: ein Vorgang, der
 * auf halbem Weg stehen bleibt.
 *
 * Ohne Audit-Eintrag: der Aufruf liest die Form der Konfiguration, keine
 * Zugangsdaten. Was danach passiert, steht in der Zeile des Vorgangs, der
 * darauf folgt — `serviceActor` gehört an die schreibenden Routen.
 *
 * Die Dienste stehen NICHT mit drin, nur ihre Anzahl. Sie kommen aus derselben
 * Probe und wären damit umsonst, aber eine Konfiguration mit vierzig Einträgen
 * schickt dann bei jedem Aufruf vierzig Objekte an einen Aufrufer, der sich für
 * die Gruppen interessiert. Wer sie will, nimmt `/services`.
 *
 * Die Logik steht in `lib/haproxy/api-actions.ts`, der MCP-Server ruft sie auch.
 */
export async function GET(request: Request) {
  try {
    await requireServiceToken(request);
    const { t } = await getT();
    return ok(await listProxies(t));
  } catch (err) {
    return handleError(err);
  }
}
