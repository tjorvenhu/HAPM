/**
 * Die angebundenen Domains, und ob ihr Zugang gerade funktioniert.
 *
 * Die Zeilen kommen aus der Datenbank, die Prüfung vom Anbieter: je Zone und
 * Aufruf fragt HAPM mit dem Token, welche Zonen er sieht. Steht die Zone
 * darunter, funktioniert der Zugang, und der Anbieter sagt dabei, ob die
 * Nameserver auf ihn zeigen (`delegated`, `null` heißt unbekannt). Ein
 * gespeicherter Zustand wäre genau dann falsch, wenn der Token beim Anbieter
 * zurückgezogen wurde.
 *
 * Scheitert eine Zone, fällt nicht die Liste aus: sie steht mit ihrem Fehler
 * daneben. Gebraucht von der Seite `/dns` (`app/api/dns/zones`) und vom
 * MCP-Server. Der Token verlässt den Server nicht (`forClient`).
 */

import { ApiError } from '../api';
import { msg, type Locale } from '../i18n';
import { providerFor } from './provider';
import { forClient, listZoneRows, withZone, zoneErrorText, type ZoneForClient } from './store';
import { normalizeDomain } from './zones';

export type CheckedZone = Omit<ZoneForClient, 'status' | 'lastCheckedAt' | 'lastError'> & {
  status: 'ok' | 'error';
  lastCheckedAt: string;
  lastError: string | null;
  delegated: boolean | null;
};

export async function checkZones(locale: Locale): Promise<CheckedZone[]> {
  const zones = await listZoneRows();

  return Promise.all(
    zones.map(async (zone) => {
      const lastCheckedAt = new Date().toISOString();
      try {
        const found = await withZone(zone, async (token) => {
          const visible = await providerFor(zone).listZones(token);
          const match = visible.find((seen) => normalizeDomain(seen.name) === normalizeDomain(zone.name));
          if (!match) throw new ApiError(msg('Der Token sieht diese Zone nicht mehr.'), 404);
          return match;
        });
        return {
          ...forClient(zone),
          status: 'ok' as const,
          lastCheckedAt,
          lastError: null,
          delegated: found.delegated,
        };
      } catch (err) {
        return {
          ...forClient(zone),
          status: 'error' as const,
          lastCheckedAt,
          lastError: zoneErrorText(err, locale),
          delegated: null,
        };
      }
    })
  );
}
