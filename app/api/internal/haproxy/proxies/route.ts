import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError } from '@/lib/api';
import { getT } from '@/lib/i18n/server';
import { proxyServers, proxyView, type ProxyView } from '@/lib/haproxy/internal';

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
 */
export async function GET(request: Request) {
  try {
    await requireServiceToken(request);

    const servers = await proxyServers();
    const rows: ProxyView[] = await Promise.all(servers.map(proxyView));
    const { t } = await getT();

    return ok(rows.map((row) => ({ ...row, error: row.error === null ? null : t(row.error) })));
  } catch (err) {
    return handleError(err);
  }
}
