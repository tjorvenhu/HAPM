/**
 * Aus einer Datei von DB-IP die gültige Länder-Tabelle machen.
 *
 * Zwei Wege führen hierher: der eigene Abruf (`./fetch.ts`) und der Upload von
 * Hand (`app/api/geoip/route.ts`). Beide müssen dieselbe Datei gleich
 * behandeln, also dieselben Grenzen und dieselbe Prüfung, ob überhaupt Bereiche
 * herauskamen. Deshalb eine Funktion und nicht zwei.
 *
 * Was hier scheitert, ist eine Auskunft an den Menschen und kein Absturz: es
 * wirft `GeoTableError` mit einem Satz, der so angezeigt werden kann.
 */

import { msg } from '../i18n/translate';
import { compileGeoTable, GeoTableError } from './format';
import { GEOIP_MAX_UPLOAD_BYTES, GEOIP_SOURCE_NAME, unpackUpload } from './pack';
import { storeGeoipTable } from './store';
import { followGeoipChange } from './follow';

export interface GeoipImport {
  version: string;
  countryCount: number;
  v4Count: number;
  v6Count: number;
}

export async function importGeoipFile(input: {
  /** Die Datei, wie DB-IP sie ausliefert (`.csv.gz`) oder ausgepackt. */
  bytes: Uint8Array;
  /**
   * Der Monat des Datensatzes, `2026-08`. Er steht nur im Dateinamen, in der
   * CSV selbst nicht. Er wird hier geprüft und nicht erraten: an dieser Zahl
   * hängt später, ob die Tabelle als aktuell gilt.
   */
  version: string;
  /** Wer sie hochgeladen oder den Abruf ausgelöst hat. */
  uploadedBy: string | null;
  /** Über den eigenen Abruf gekommen und nicht hochgeladen. */
  fetched?: boolean;
}): Promise<GeoipImport> {
  const version = input.version.trim();
  if (!/^\d{4}-\d{2}$/.test(version)) {
    throw new GeoTableError(
      msg(
        'Der Stand der Datei fehlt oder ist unlesbar. Erwartet wird ein Monat wie 2026-08. DB-IP schreibt ihn in den Dateinamen.'
      )
    );
  }

  if (input.bytes.length === 0) throw new GeoTableError(msg('Es wurde keine Datei übertragen.'));
  if (input.bytes.length > GEOIP_MAX_UPLOAD_BYTES) {
    throw new GeoTableError(
      msg('Die Datei ist größer als {mb} MB.', { mb: Math.round(GEOIP_MAX_UPLOAD_BYTES / 1024 / 1024) })
    );
  }

  const builtAt = new Date().toISOString();
  const built = compileGeoTable(unpackUpload(input.bytes), {
    version,
    source: GEOIP_SOURCE_NAME,
    builtAt,
  });

  // Eine Datei, aus der keine Bereiche wurden, ist die falsche Datei: meist die
  // City-Fassung, ein CSV mit Kopfzeile aus einer anderen Quelle oder eine
  // Fehlerseite statt des Datensatzes. Ohne diese Prüfung ersetzte sie die
  // vorhandene Tabelle durch nichts.
  if (built.v4Count < 1000 || built.v6Count < 1000) {
    throw new GeoTableError(
      msg(
        'Aus der Datei wurden nur {v4} IPv4- und {v6} IPv6-Bereiche. Erwartet wird der Datensatz „IP to Country Lite" mit den Spalten Anfang, Ende, Ländercode.',
        { v4: built.v4Count, v6: built.v6Count }
      )
    );
  }

  await storeGeoipTable({
    bytes: built.bytes,
    version,
    source: GEOIP_SOURCE_NAME,
    builtAt,
    countryCount: built.countries.length,
    v4Count: built.v4Count,
    v6Count: built.v6Count,
    uploadedBy: input.uploadedBy,
    fetched: input.fetched === true,
  });
  followGeoipChange();

  return {
    version,
    countryCount: built.countries.length,
    v4Count: built.v4Count,
    v6Count: built.v6Count,
  };
}
