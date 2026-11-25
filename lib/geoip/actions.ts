/**
 * Die Länder-Tabelle erneuern und den Schalter dafür setzen: die Seite unter
 * „Reverse-Proxy → Statistik", die interne API (`/api/internal/geoip`) und der
 * MCP-Server rufen dieselben Funktionen, das Protokoll schreiben sie selbst.
 *
 * Der Upload von Hand und das Zurücksetzen bleiben in der Oberfläche: das
 * erste ist eine Datei von 4,5 MB, das zweite der Weg zurück nach einem
 * falschen Upload.
 */

import { ApiError } from '../api';
import { msg } from '../i18n';
import { logAudit } from '../audit';
import { geoipOverview, refreshGeoip, setGeoipAutoRefresh } from './fetch';
import { readGeoipRefresh } from './store';

export interface GeoipActor {
  userId: string;
  userEmail: string;
  ip?: string;
}

/**
 * „Jetzt erneuern": die Länder-Tabelle sofort von db-ip.com holen, ohne die
 * 24-Stunden-Sperre des Schedulers. Wartet, bis der Abruf durch ist.
 */
export async function refreshGeoipNow(actor: GeoipActor) {
  const result = await refreshGeoip({ actor: actor.userEmail });
  // 502: HAPM selbst ist in Ordnung, die Gegenseite hat nicht geliefert.
  if (!result.ok) throw new ApiError(result.error ?? msg('Der Abruf ist gescheitert.'), 502);

  const overview = await geoipOverview();
  if (result.changed) {
    await logAudit({
      ...actor,
      action: 'geoip_table_updated',
      resource: 'settings',
      resourceId: 'geoip',
      details:
        `Länder-Tabelle von db-ip.com geholt, Stand ${result.version}: ${overview.v4Count} IPv4- und ` +
        `${overview.v6Count} IPv6-Bereiche`,
    });
  }

  return { ...overview, changed: result.changed };
}

/** Der Schalter „Selbsttätig erneuern". */
export async function changeGeoipAutoRefresh(autoRefresh: unknown, actor: GeoipActor) {
  if (typeof autoRefresh !== 'boolean') {
    throw new ApiError(msg('Der Schalter für das selbsttätige Erneuern kennt nur an und aus.'));
  }

  const before = await readGeoipRefresh();
  await setGeoipAutoRefresh(autoRefresh);

  if (before.autoRefresh !== autoRefresh) {
    await logAudit({
      ...actor,
      action: 'settings_updated',
      resource: 'settings',
      resourceId: 'geoip',
      details: `Selbsttätiges Erneuern der Länder-Tabelle ${autoRefresh ? 'eingeschaltet' : 'abgeschaltet'}`,
    });
  }

  return geoipOverview();
}
