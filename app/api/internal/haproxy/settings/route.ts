import { requireServiceToken } from '@/lib/service-auth';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { serviceActor } from '@/lib/audit';
import { precheckSettings, readGlobalSettings } from '@/lib/haproxy/provision';
import { startHaproxyRun } from '@/lib/haproxy/runner';
import { haproxyActor, resolveProxy } from '@/lib/haproxy/internal';
import {
  HaproxyConfigError,
  readGlobalSettingsPatch,
  settingsEditable,
  validateGlobalSettings,
} from '@/lib/haproxy/config';

/**
 * Was keinem Dienst gehört, sondern der ganzen Konfiguration: die Zeilen unter
 * `# Globale HTTPS-Settings` und die Admin-Adressliste.
 *
 * Die Adressliste ist der Grund, warum es diese Route gibt. Sie ist EINE Liste
 * (`acl admin_ips src …`), auf die jeder gesperrte Eintrag zeigt — eine neue
 * Büro-IP einzutragen ist damit ein Vorgang, der genau hier stattfindet und
 * nirgendwo sonst.
 */

/** Zeigt, was in der Konfiguration steht — samt der Dienste, die daran hängen. */
export async function GET(request: Request) {
  try {
    await requireServiceToken(request);

    const server = await resolveProxy(new URL(request.url).searchParams.get('serverId'));
    const { settings, dnsHooks } = await readGlobalSettings(server);

    return ok({
      serverId: server.$id,
      serverName: server.name,
      httpsLines: settings.httpsLines,
      adminIps: settings.adminIps,
      /** Steht die ACL mehr als einmal in der Datei, wird sie nicht angefasst. */
      adminEditable: settings.adminEditable,
      /**
       * Die Dienste, die gerade nur für diese Adressen erreichbar sind. Sie
       * stehen hier, weil die Liste zu leeren, während einer davon gesperrt
       * ist, die Konfiguration ungültig macht: eine Regel ohne ihre ACL ist
       * „unknown acl", und HAProxy lehnt dann die ganze Datei ab.
       */
      lockedServices: settings.lockedServices,
      /** `false` heißt: der Marker fehlt, es gibt keine Stelle für die Zeilen. */
      editable: settingsEditable(settings),
      dnsHooks,
    });
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
    const body = await jsonBody<{
      serverId?: string;
      httpsLines?: string[];
      adminIps?: string[];
      addAdminIps?: string[];
      removeAdminIps?: string[];
    }>(request);

    const server = await resolveProxy(body.serverId);

    // Der Ist-Stand ist die Grundlage des Patches: gelesen wird er hier, und
    // unmittelbar vor dem Schreiben liest der Lauf ihn im Lock noch einmal samt
    // Prüfsummenvergleich. Wer dazwischen von Hand editiert hat, behält seine
    // Änderung — der Vorgang bricht ab, statt sie zu überschreiben.
    const { settings } = await readGlobalSettings(server);
    const input = readGlobalSettingsPatch(body, settings);
    if ('error' in input) throw new ApiError(input.error);

    const invalid = validateGlobalSettings(input);
    if (invalid) throw new ApiError(invalid);

    try {
      await precheckSettings(server, input);
    } catch (err) {
      // Fehlender Marker, doppelte Admin-ACL, ein gesperrter Dienst ohne
      // Adressen: eine Auskunft an den Aufrufer und kein 500er.
      if (err instanceof HaproxyConfigError) throw new ApiError(err.message, 409);
      throw err;
    }

    const run = await startHaproxyRun({
      server,
      action: 'settings',
      serviceId: 'globale-einstellungen',
      settings: input,
      actor: haproxyActor(serviceActor(service), request),
    });

    return ok({ runId: run.$id, serverId: server.$id, adminIps: input.adminIps });
  } catch (err) {
    return handleError(err);
  }
}
