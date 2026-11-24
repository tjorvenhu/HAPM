/**
 * Packen, auspacken und die Konstanten, die beide Seiten brauchen.
 *
 * Eine eigene Datei zwischen `./format.ts` (rein, ohne Importe) und
 * `./store.ts` (Datenbank und Dateisystem), damit `./build.ts` sie benutzen
 * kann, ohne `lib/db` mitzuziehen: das Skript läuft über `tsx` gegen eine
 * heruntergeladene Datei und hat mit der Datenbank nichts zu tun.
 */

import { gunzipSync, gzipSync } from 'node:zlib';
import { msg } from '../i18n/translate';
import { GeoTableError } from './format';

/** Wo der Datensatz herkommt. Steht im Hinweis, damit niemand suchen muss. */
export const GEOIP_SOURCE_URL = 'https://db-ip.com/db/download/ip-to-country-lite';

/** Wie die Quelle heißt, wenn eine Datei nichts anderes sagt. */
export const GEOIP_SOURCE_NAME = 'DB-IP IP to Country Lite';

/**
 * Die Adresse der Datei eines Monats.
 *
 * Steht hier und nicht in `./fetch.ts`, weil `./build.ts` dieselbe Adresse
 * braucht und `lib/db` nicht mitziehen soll. `month` zählt von 1.
 */
export function geoipDownloadUrl(year: number, month: number): string {
  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw new RangeError(`Kein Jahr, zu dem es einen Datensatz gibt: ${year}`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(`Kein Monat: ${month}`);
  }
  return `https://download.db-ip.com/free/dbip-country-lite-${year}-${String(month).padStart(2, '0')}.csv.gz`;
}

/**
 * Ab wann der Hinweis über dem Dashboard steht.
 *
 * DB-IP veröffentlicht monatlich. 75 Tage sind der Punkt, ab dem die Zuordnung
 * spürbar von der Wirklichkeit abweicht, ohne dass nach jedem Monatswechsel
 * eine Fläche aufgeht und deshalb weggeklickt wird, ohne gelesen zu werden.
 */
export const GEOIP_STALE_DAYS = 75;

/** Größer nimmt weder der Upload noch der eigene Abruf an. Der gepackte
 *  Datensatz liegt bei 4,5 MB; 32 sind reichlich Luft und trotzdem eine Grenze. */
export const GEOIP_MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

export function packTable(bytes: Uint8Array): Buffer {
  return gzipSync(bytes, { level: 9 });
}

export function unpackTable(bytes: Uint8Array): Buffer {
  return gunzipSync(bytes);
}

/**
 * Aus einer hochgeladenen Datei Text machen.
 *
 * Angenommen wird die Datei so, wie DB-IP sie ausliefert (`.csv.gz`) und
 * ausgepackt (`.csv`). Erkannt wird das an den beiden Kennbytes und nicht an
 * der Endung: wer eine `.gz` vorher auspackt und den Namen stehen lässt, soll
 * nicht an einer Meldung hängenbleiben.
 */
export function unpackUpload(bytes: Uint8Array): string {
  const gzipped = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  try {
    return Buffer.from(gzipped ? gunzipSync(bytes) : bytes).toString('utf8');
  } catch {
    throw new GeoTableError(msg('Die Datei ließ sich nicht auspacken.'));
  }
}
