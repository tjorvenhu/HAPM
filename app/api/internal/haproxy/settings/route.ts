import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError, jsonBody } from '@/lib/api';
import { serviceActor } from '@/lib/audit';
import { haproxyActor } from '@/lib/haproxy/internal';
import { getProxySettings, patchProxySettings } from '@/lib/haproxy/api-actions';

/**
 * Was keinem Dienst gehört, sondern der ganzen Konfiguration: die Zeilen unter
 * `# Globale HTTPS-Settings` und die Admin-Adressliste.
 *
 * Die Adressliste ist der Grund, warum es diese Route gibt. Sie ist EINE Liste
 * (`acl admin_ips src …`), auf die jeder gesperrte Eintrag zeigt — eine neue
 * Büro-IP einzutragen ist damit ein Vorgang, der genau hier stattfindet und
 * nirgendwo sonst.
 *
 * In der Antwort von GET stehen auch `lockedServices` (die Dienste, die gerade
 * nur für diese Adressen erreichbar sind: die Liste zu leeren, während einer
 * davon gesperrt ist, machte die Konfiguration ungültig) und `editable`
 * (`false`: der Marker fehlt). Die Logik steht in `lib/haproxy/api-actions.ts`.
 */

export async function GET(request: Request) {
  try {
    await requireServiceToken(request);
    return ok(await getProxySettings(new URL(request.url).searchParams.get('serverId')));
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Die Einstellungen ändern.
 *
 * **Was nicht im Rumpf steht, bleibt stehen** — anders als beim Dialog, der
 * immer beide Listen schickt, weil beide auf dem Bildschirm stehen. Ein Aufruf,
 * der eine Admin-Adresse einträgt, soll nicht nebenbei HSTS abschalten. Für die Adressliste gibt es deshalb drei Formen, und
 * `readGlobalSettingsPatch` erklärt, warum `adminIps` und
 * `addAdminIps`/`removeAdminIps` zusammen abgelehnt werden:
 *
 *   { "addAdminIps": ["203.0.113.7"] }        eine dazu
 *   { "removeAdminIps": ["203.0.113.7"] }     eine weg
 *   { "adminIps": ["10.0.0.0/8"] }            die ganze Liste ersetzen
 *
 * Wie bei einem Dienst antwortet die Route mit der Lauf-ID: geprüft, eingesetzt
 * und reloadet wird abgekoppelt, über denselben Weg (Lock, Prüfsumme,
 * `haproxy -c`, Backup, Reload) — nur ohne Zertifikat.
 */
export async function PATCH(request: Request) {
  try {
    const service = await requireServiceToken(request);
    const body = await jsonBody(request);
    return ok(await patchProxySettings(body, haproxyActor(serviceActor(service), request)));
  } catch (err) {
    return handleError(err);
  }
}
