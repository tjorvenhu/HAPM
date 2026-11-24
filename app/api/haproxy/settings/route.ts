import { requireSession, requireCsrf } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { getT } from '@/lib/i18n/server';
import { getClientIP } from '@/lib/audit';
import {
  getProxyServer,
  readGlobalSettings,
  precheckSettings,
} from '@/lib/haproxy/provision';
import { startHaproxyRun } from '@/lib/haproxy/runner';
import {
  HaproxyConfigError,
  readGlobalSettingsInput,
  validateGlobalSettings,
  settingsEditable,
  type GlobalSettings,
} from '@/lib/haproxy/config';
import { LOCAL_SERVER_ID, localServer } from '@/lib/helpers';

/**
 * Die globalen Einstellungen eines Reverse-Proxys: die Zeilen unter
 * `# Globale HTTPS-Settings` und die Adresse, auf die unbekannte Domains
 * umgeleitet werden.
 *
 * Wie bei den Diensten steht keine Collection dahinter — gelesen wird bei jedem
 * Aufruf `/etc/haproxy/haproxy.cfg` auf der Maschine. Eine Spiegelung wäre eine
 * zweite Quelle, die genau dann falsch ist, wenn jemand die Datei von Hand
 * angefasst hat.
 */

interface SettingsRow {
  $id: string;
  name: string;
  host: string;
  settings: GlobalSettings | null;
  /** Die eingerichteten acme.sh-DNS-Hooks. Sie stehen hier, weil die Seite die
   *  Zugangsdaten dafür setzt — geschrieben werden sie über eine eigene Route,
   *  gelesen kommen sie aus derselben Probe wie die Einstellungen. */
  dnsHooks: string[];
  editable: boolean;
  error: string | null;
}

export async function GET() {
  try {
    await requireSession();
    const { t } = await getT();

    const servers = [localServer()];

    // Einzeln scheitern lassen: ein Proxy, der gerade nicht antwortet, ist eine
    // Auskunft und kein Grund, die übrigen wegzulassen.
    const rows: SettingsRow[] = await Promise.all(
      servers.map(async (server) => {
        const base = { $id: server.$id, name: server.name, host: server.host };
        try {
          const { settings, dnsHooks } = await readGlobalSettings(server);
          return {
            ...base,
            settings,
            dnsHooks,
            editable: settingsEditable(settings),
            error: null,
          };
        } catch (err) {
          return {
            ...base,
            settings: null,
            dnsHooks: [],
            editable: false,
            error: err instanceof Error ? err.message : t('HAProxy ist nicht erreichbar.'),
          };
        }
      })
    );

    rows.sort((a, b) => a.name.localeCompare(b.name, 'de'));
    return ok(rows);
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Die Einstellungen schreiben. Wie beim Anlegen eines Ziels antwortet die Route
 * mit der Lauf-ID: geprüft und eingesetzt wird abgekoppelt, sichtbar in der
 * Pille unten rechts.
 */
export async function PATCH(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody<{ serverId?: string }>(request);

    const server = await getProxyServer(body.serverId || LOCAL_SERVER_ID);

    const input = readGlobalSettingsInput(body);
    // Dieselbe Funktion wie im Formular. Ein Dialog, der etwas durchlässt, was
    // die Route danach ablehnt, ist schlimmer als gar keine Vorabprüfung.
    const invalid = validateGlobalSettings(input);
    if (invalid) throw new ApiError(invalid);

    try {
      await precheckSettings(server, input);
    } catch (err) {
      // Fehlender Marker, kein default_404, doppelte Admin-ACL: eine Auskunft an
      // den Benutzer und kein 500er.
      if (err instanceof HaproxyConfigError) throw new ApiError(err, 409);
      throw err;
    }

    const run = await startHaproxyRun({
      server,
      action: 'settings',
      serviceId: 'globale-einstellungen',
      settings: input,
      actor: { userId: session.userId, email: session.email, ip: getClientIP(request) },
    });

    return ok({ runId: run.$id });
  } catch (err) {
    return handleError(err);
  }
}
