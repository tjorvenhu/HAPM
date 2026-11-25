/**
 * Grundkonfiguration und Fehlerseiten: lesen und auf den Stand bringen. Die
 * Seiten „Einstellungen" und „Fehlerseiten" des Reverse-Proxys, die interne
 * API und der MCP-Server rufen dieselben Funktionen.
 *
 * Die Logik stand vorher in `app/api/haproxy/base-config/route.ts` und
 * `app/api/haproxy/error-pages/route.ts`. Beides ist synchron: kein
 * Zertifikat, ein `haproxy -c`, ein Reload. Die Schritte kommen in der Antwort
 * zurück und stehen im Protokoll.
 *
 * Das Design der Fehlerseiten selbst (Farben, Logo, eigenes HTML) ändert nur
 * die Oberfläche: es ist Gestaltung mit Vorschau und Datei-Upload, keine
 * Automatisierung (docs/mcp.md).
 */

import { ApiError } from '../api';
import { msg } from '../i18n/translate';
import type { Locale } from '../i18n';
import { logAudit } from '../audit';
import { LOCAL_SERVER_ID, localServer } from '../helpers';
import { getProxyServer, readBaseConfigDiff, readErrorPages, updateBaseConfig } from './provision';
import { applyPageDesign } from './page-design-apply';
import { loadPageDesign } from './page-design-store';
import type { BaseConfigDiff } from './base-config-diff';
import type { ErrorPageEntry } from './error-pages';

export interface MaintenanceActor {
  userId: string;
  userEmail: string;
  ip?: string;
}

type Translate = (text: string) => string;

/** Ein Proxy, der gerade nicht antwortet, ist eine Auskunft und kein Fehler der Seite. */
function rowError(err: unknown, t: Translate, locale: Locale): string {
  return err instanceof ApiError
    ? err.localized(locale)
    : err instanceof Error
      ? err.message
      : t('HAProxy ist nicht erreichbar.');
}

/* ── Grundkonfiguration ── */

export interface BaseConfigRow {
  $id: string;
  name: string;
  diff: BaseConfigDiff | null;
  error: string | null;
}

/** Eine Auswahl ist klein. Mehr als das kommt aus keiner Oberfläche. */
const MAX_IDS = 200;

/** `global|missing|limited-quic` wird zu `global: limited-quic`. Gekürzt, weil
 *  eine lange Auswahl sonst die Zeile im Protokoll sprengt. */
function baseConfigAuditDetails(ids: string[], failed: string | null): string {
  const lines = ids.map((id) => id.replace(/\|(missing|changed)\|/, ': ')).join(', ');
  const text = `Grundkonfiguration abgeglichen: ${lines}${failed ? ` (fehlgeschlagen: ${failed})` : ''}`;
  return text.length > 1000 ? `${text.slice(0, 997)}...` : text;
}

/** Der Abgleich von `haproxy.cfg` mit der Grundkonfiguration, die HAPM heute schriebe. */
export async function readBaseConfigRows(t: Translate, locale: Locale): Promise<BaseConfigRow[]> {
  const servers = [localServer()];
  return Promise.all(
    servers.map(async (server) => {
      const base = { $id: server.$id, name: server.name };
      try {
        return { ...base, diff: await readBaseConfigDiff(server), error: null };
      } catch (err) {
        return { ...base, diff: null, error: rowError(err, t, locale) };
      }
    })
  );
}

/**
 * Die ausgewählten Abweichungen übernehmen. Der Rumpf nennt sie mit ihrer ID
 * aus dem Abgleich. Welche Zeile wohin kommt, rechnet der Vorgang selbst und
 * innerhalb des Locks: gibt es eine ID nicht mehr, bricht er ab.
 */
export async function applyBaseConfig(body: { serverId?: unknown; ids?: unknown }, actor: MaintenanceActor) {
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (ids.length === 0 || ids.length > MAX_IDS || !ids.every((id) => typeof id === 'string')) {
    throw new ApiError(msg('Es wurde keine Abweichung ausgewählt.'));
  }

  const server = await getProxyServer((typeof body.serverId === 'string' && body.serverId) || LOCAL_SERVER_ID);
  const result = await updateBaseConfig(server, ids as string[]);
  const failed = result.steps.find((step) => !step.ok);

  await logAudit({
    ...actor,
    action: failed ? 'haproxy_base_config_failed' : 'haproxy_base_config_updated',
    resource: 'server',
    resourceId: server.$id,
    details: baseConfigAuditDetails(ids as string[], failed?.label ?? null),
  });

  return result;
}

/* ── Fehlerseiten ── */

export interface ErrorPagesRow {
  $id: string;
  name: string;
  entries: ErrorPageEntry[];
  error: string | null;
}

/** Welche Dateien `haproxy.cfg` nennt, und ob sie dem gespeicherten Design entsprechen. */
export async function readErrorPageRows(t: Translate, locale: Locale): Promise<ErrorPagesRow[]> {
  // Der Zustand einer Datei ist ein Vergleich mit dem gespeicherten Design.
  await loadPageDesign();
  const servers = [localServer()];

  const rows: ErrorPagesRow[] = await Promise.all(
    servers.map(async (server) => {
      const base = { $id: server.$id, name: server.name };
      try {
        return { ...base, entries: await readErrorPages(server), error: null };
      } catch (err) {
        return { ...base, entries: [], error: rowError(err, t, locale) };
      }
    })
  );

  rows.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return rows;
}

/**
 * Die Fehlerdateien und die Seiten der Passwortabfrage neu schreiben, im
 * gespeicherten Design.
 *
 * Der Rumpf nennt nur die Maschine. WELCHE Dateien geschrieben werden und mit
 * welchem Status, liest der Vorgang selbst und innerhalb des Locks: eine Liste
 * von außen wäre eine Momentaufnahme von vorhin und ein Pfad, den jemand
 * anderes bestimmt hat.
 */
export async function redeployErrorPages(body: { serverId?: unknown }, actor: MaintenanceActor) {
  const server = await getProxyServer((typeof body.serverId === 'string' && body.serverId) || LOCAL_SERVER_ID);

  await loadPageDesign();
  const result = await applyPageDesign(server);
  const failed = result.steps.find((step) => !step.ok);

  await logAudit({
    ...actor,
    action: failed ? 'haproxy_error_pages_failed' : 'haproxy_error_pages_updated',
    resource: 'server',
    resourceId: server.$id,
    details:
      'Fehlerseiten: ' +
      result.steps.map((step) => `${step.ok ? '' : 'fehlgeschlagen: '}${step.label}`).join(', '),
  });

  return result;
}
