/**
 * Die mitgelieferte Länder-Tabelle neu bauen.
 *
 *     pnpm geoip:build                  # holt den aktuellen Monat von DB-IP
 *     pnpm geoip:build ./dbip.csv.gz    # nimmt eine Datei, die schon da ist
 *
 * Das Ergebnis landet in `./data/` und gehört ins Repository. Im laufenden
 * Betrieb braucht man dieses Skript nicht: HAPM holt sich jeden Monat selbst
 * eine neuere Fassung (`./fetch.ts`), und die gewinnt gegen die mitgelieferte
 * (siehe `./store.ts`). Das hier ist der Weg, mit dem der Ausgangsstand im
 * Repository erneuert wird.
 *
 * Übersetzt wird mit **derselben** Funktion, die auch Abruf und Upload benutzen
 * (`compileGeoTable`). Zwei Übersetzer wären zwei, die irgendwann verschiedene
 * Tabellen aus derselben Datei machen.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { compileGeoTable } from './format';
import { packTable, unpackUpload, geoipDownloadUrl, GEOIP_SOURCE_NAME } from './pack';

const OUT_DIR = path.join(process.cwd(), 'lib', 'geoip', 'data');
const OUT_FILE = path.join(OUT_DIR, 'dbip-country-lite.bin.gz');

/** Der Stand, den DB-IP gerade anbietet: der laufende Monat. */
function currentVersion(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function downloadUrl(version: string): string {
  const [year, month] = version.split('-').map(Number);
  return geoipDownloadUrl(year, month);
}

async function main() {
  const argument = process.argv[2];
  let raw: Uint8Array;
  let version = currentVersion();

  if (argument && !argument.startsWith('http')) {
    raw = await readFile(argument);
    // Aus `dbip-country-lite-2026-08.csv.gz` den Stand ziehen. Steht er nicht im
    // Namen, bleibt der laufende Monat — falsch wäre nur, ihn zu erfinden, und
    // eine Datei ohne Stand kommt aus einer Hand, die ihn kennt.
    const named = /(\d{4}-\d{2})/.exec(path.basename(argument));
    if (named) version = named[1];
  } else {
    const url = argument || downloadUrl(version);
    process.stdout.write(`Lade ${url} …\n`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `${url} antwortete mit ${response.status}. Der Datensatz für ${version} ist ` +
          'möglicherweise noch nicht veröffentlicht — dann den Vormonat angeben.'
      );
    }
    raw = new Uint8Array(await response.arrayBuffer());
  }

  const csv = unpackUpload(raw);
  const built = compileGeoTable(csv, {
    version,
    source: GEOIP_SOURCE_NAME,
    builtAt: new Date().toISOString(),
  });

  const packed = packTable(built.bytes);
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, packed);

  process.stdout.write(
    `${OUT_FILE}\n` +
      `  Stand ${version}, ${built.countries.length} Länder\n` +
      `  ${built.v4Count.toLocaleString('de-DE')} IPv4-Bereiche, ` +
      `${built.v6Count.toLocaleString('de-DE')} IPv6-Bereiche\n` +
      `  ${(packed.length / 1024).toFixed(0)} KB gepackt ` +
      `(${(built.bytes.length / 1024 / 1024).toFixed(1)} MB roh)\n`
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
