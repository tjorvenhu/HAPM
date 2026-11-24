/**
 * Woher die Länder-Tabelle kommt und wann sie zu alt ist.
 *
 * `./format.ts` kann übersetzen und suchen und hat keine Importe. Hier wird
 * geredet: eine Datei aus dem Repository lesen, eine hochgeladene Fassung aus
 * Postgres holen, beides im Prozess halten und beantworten, ob jemand sie
 * erneuern sollte.
 *
 * ── Zwei Quellen, und die zweite gewinnt ──
 *
 * Im Repository liegt eine übersetzte Fassung (`./data/`). Sie ist da, damit
 * eine frische Installation sofort Länder anzeigt und nicht erst nach einem
 * Upload. Sie altert aber mit jedem Monat, in dem niemand das Repository
 * anfasst — Adressbereiche werden ständig neu vergeben.
 *
 * Deshalb kann eine neuere Fassung **hochgeladen** werden, und die liegt in
 * Postgres und nicht auf der Platte. Der Grund ist der Betrieb: HAPM läuft als
 * Container aus einem Abbild, und ein Update ersetzt den Container samt
 * Dateisystem. Eine hochgeladene Datei neben dem Build wäre beim nächsten
 * Update weg — und zwar still, mit einer Tabelle, die danach wieder den Stand
 * des Repositories hat.
 *
 * Im Normalfall kommt die neuere Fassung nicht von Hand: HAPM holt sie sich
 * jeden Monat selbst (`./fetch.ts`). Sie liegt an derselben
 * Stelle wie eine hochgeladene und trägt `fetched`, damit die Oberfläche
 * sagen kann, auf welchem Weg sie kam.
 *
 * An derselben Zeile stehen auch der Schalter für das selbsttätige Holen und
 * der letzte Versuch (`readGeoipRefresh`). `updateDocument` mischt, ein Upload
 * oder das Zurücksetzen lässt sie also stehen.
 *
 * ── Warum das gecacht wird ──
 *
 * Zurückgelesen sind es 700 000 Bereiche. Das Auspacken und Auffalten dauert
 * ein paar hundert Millisekunden und darf nicht bei jeder Anfrage passieren;
 * eine Auswertung schlägt außerdem Zehntausende Adressen in einem Lauf nach.
 * Der Cache hängt an `globalThis` wie der Scheduler, damit ein HMR-Neuaufbau im
 * Dev-Modus ihn nicht wegwirft.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getSingleton, updateDocument } from '../db';
import { COLLECTIONS } from '../types';
import { decodeGeoTable, type GeoTable } from './format';
import { packTable, unpackTable, GEOIP_STALE_DAYS } from './pack';
import type { GeoipTable } from '../types';

/** Der Dateiname im Repository. Erzeugt von `lib/geoip/build.ts`. */
const BUNDLED_FILE = 'dbip-country-lite.bin.gz';

const g = globalThis as typeof globalThis & {
  __hapm_geoip?: { key: string; table: GeoTable } | null;
};

/**
 * Die Zeile samt der Felder, die `GeoipTable` in `lib/types.ts` noch nicht
 * führt. Alle vier fehlen an einer Zeile aus der Zeit davor, deshalb optional.
 */
type GeoipRow = GeoipTable & {
  /** Die Fassung kam über den eigenen Abruf und nicht über einen Upload. */
  fetched?: boolean;
  /** Der Schalter „selbsttätig holen". Fehlt er, gilt: an. */
  autoRefresh?: boolean;
  lastAttemptAt?: string | null;
  lastAttemptError?: string | null;
};

/* ══════════════════════════════════════════════════════════════════════
 * Lesen
 * ══════════════════════════════════════════════════════════════════════ */

/** Woher die gerade gültige Tabelle stammt. */
export type GeoipOrigin = 'fetched' | 'uploaded' | 'bundled' | 'none';

export interface GeoipStatus {
  origin: GeoipOrigin;
  /** Der Stand des Datensatzes, wie der Anbieter ihn nennt (`2026-08`). */
  version: string | null;
  source: string | null;
  /** Wann die Fassung übersetzt wurde, ISO. `null` heißt: keine Tabelle. */
  builtAt: string | null;
  /** Nur bei einer geholten oder hochgeladenen Fassung gesetzt. */
  uploadedAt: string | null;
  /** Wer sie hochgeladen oder den Abruf ausgelöst hat. `null` bei einem
   *  selbsttätigen Abruf. */
  uploadedBy: string | null;
  v4Count: number | null;
  v6Count: number | null;
  /** Tage seit `builtAt`, oder `null`, wenn es keine Tabelle gibt. */
  ageDays: number | null;
  /**
   * Ob der Hinweis stehen soll.
   *
   * Auch **ohne** Tabelle wahr: „gar keine Länderzuordnung" ist der dringendere
   * Fall von „veraltet", nicht das Gegenteil davon.
   */
  stale: boolean;
}

/** Die geholte oder hochgeladene Fassung, oder eine leere Zeile. */
async function storedRow() {
  return getSingleton<GeoipRow>(COLLECTIONS.GEOIP_TABLE, 'current', {
    version: '',
    source: '',
    builtAt: '',
    uploadedAt: '',
    uploadedBy: null,
    countryCount: 0,
    v4Count: 0,
    v6Count: 0,
    payload: '',
  });
}

/**
 * Die Datei aus dem Repository.
 *
 * Gesucht wird an mehreren Stellen, weil `process.cwd()` im Entwicklungsmodus
 * das Projekt ist und im `standalone`-Build dessen Nachbau. Damit die Datei
 * dort überhaupt liegt, trägt `next.config.ts` sie unter
 * `outputFileTracingIncludes` ein — Next verfolgt nur, was importiert wird, und
 * eine zur Laufzeit gelesene Datei ist das nicht.
 *
 * Fehlt sie, ist das **kein Fehler**, sondern eine Tabelle, die es nicht gibt:
 * die Statistik zeigt dann Striche statt Flaggen und der Hinweis über dem
 * Dashboard sagt, was zu tun ist.
 */
async function bundledBytes(): Promise<Uint8Array | null> {
  const candidates = [
    path.join(process.cwd(), 'lib', 'geoip', 'data', BUNDLED_FILE),
    path.join(process.cwd(), '..', 'lib', 'geoip', 'data', BUNDLED_FILE),
  ];
  for (const candidate of candidates) {
    try {
      return await readFile(candidate);
    } catch {
      // Nächster Kandidat.
    }
  }
  return null;
}

/**
 * Die gültige Tabelle: hochgeladen, sonst mitgeliefert, sonst keine.
 *
 * Der Cache-Schlüssel ist die Herkunft samt Stand. Damit wirkt ein Upload
 * sofort, ohne dass irgendwo ein Zwischenspeicher geleert werden muss — und
 * ohne dass jede Anfrage die 700 000 Bereiche neu auffaltet.
 */
export async function geoipTable(): Promise<GeoTable | null> {
  const row = await storedRow();

  if (row.payload) {
    const key = `uploaded:${row.uploadedAt}`;
    if (g.__hapm_geoip?.key === key) return g.__hapm_geoip.table;
    try {
      const table = decodeGeoTable(unpackTable(Buffer.from(row.payload, 'base64')));
      g.__hapm_geoip = { key, table };
      return table;
    } catch {
      // Eine unlesbare hochgeladene Fassung darf die mitgelieferte nicht
      // mitreißen. Sie kann nur durch einen Upload entstanden sein, der die
      // Prüfung bestanden hat — also ist hier etwas anderes kaputt.
      g.__hapm_geoip = null;
    }
  }

  if (g.__hapm_geoip?.key === 'bundled') return g.__hapm_geoip.table;
  const bytes = await bundledBytes();
  if (!bytes) return null;
  try {
    const table = decodeGeoTable(unpackTable(bytes));
    g.__hapm_geoip = { key: 'bundled', table };
    return table;
  } catch {
    return null;
  }
}

/** Was der Hinweis und die Einstellungsseite anzeigen. Liest die Tabelle mit,
 *  weil die mitgelieferte Fassung ihren Stand nur in sich selbst trägt. */
export async function geoipStatus(now = Date.now()): Promise<GeoipStatus> {
  const row = await storedRow();

  if (row.payload) {
    return describe({
      origin: row.fetched ? 'fetched' : 'uploaded',
      version: row.version || null,
      source: row.source || null,
      builtAt: row.builtAt || null,
      uploadedAt: row.uploadedAt || null,
      uploadedBy: row.uploadedBy ?? null,
      v4Count: row.v4Count,
      v6Count: row.v6Count,
      now,
    });
  }

  const table = await geoipTable();
  if (!table) {
    return {
      origin: 'none',
      version: null,
      source: null,
      builtAt: null,
      uploadedAt: null,
      uploadedBy: null,
      v4Count: null,
      v6Count: null,
      ageDays: null,
      stale: true,
    };
  }

  return describe({
    origin: 'bundled',
    version: table.version || null,
    source: table.source || null,
    builtAt: table.builtAt || null,
    uploadedAt: null,
    uploadedBy: null,
    v4Count: table.starts4.length,
    v6Count: table.starts6.length,
    now,
  });
}

function describe(input: Omit<GeoipStatus, 'ageDays' | 'stale'> & { now: number }): GeoipStatus {
  const { now, ...rest } = input;
  const built = rest.builtAt ? Date.parse(rest.builtAt) : NaN;
  // Ein unlesbares Datum heißt unbekannt und nicht „frisch": ohne Alter kann
  // niemand sagen, dass die Tabelle noch stimmt.
  const ageDays = Number.isFinite(built) ? Math.floor((now - built) / 86_400_000) : null;
  return { ...rest, ageDays, stale: ageDays === null || ageDays > GEOIP_STALE_DAYS };
}

/* ══════════════════════════════════════════════════════════════════════
 * Schreiben
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * Eine übersetzte Fassung ablegen.
 *
 * Gespeichert wird gepackt und base64-kodiert. Base64 und nicht `bytea`, weil
 * die Datenbankschicht Zeichenketten führt und eine einzelne Spalte quer durch
 * `lib/db` binär zu machen der teurere Eingriff wäre als 33 % Aufschlag auf
 * 790 KB.
 */
export async function storeGeoipTable(input: {
  bytes: Uint8Array;
  version: string;
  source: string;
  builtAt: string;
  countryCount: number;
  v4Count: number;
  v6Count: number;
  uploadedBy: string | null;
  /** Über den eigenen Abruf gekommen (`./fetch.ts`) und nicht hochgeladen. */
  fetched?: boolean;
}): Promise<void> {
  await storedRow();
  const uploadedAt = new Date().toISOString();
  await updateDocument<GeoipRow>(COLLECTIONS.GEOIP_TABLE, 'current', {
    fetched: input.fetched === true,
    version: input.version,
    source: input.source,
    builtAt: input.builtAt,
    uploadedAt,
    uploadedBy: input.uploadedBy,
    countryCount: input.countryCount,
    v4Count: input.v4Count,
    v6Count: input.v6Count,
    payload: packTable(input.bytes).toString('base64'),
  });
  // Der Schlüssel enthält `uploadedAt`, der alte Eintrag ist damit ohnehin tot.
  // Ihn hier zu löschen spart trotzdem die 700 000 Bereiche im Speicher, bis
  // das nächste Mal jemand fragt.
  g.__hapm_geoip = null;
}

/** Die geholte oder hochgeladene Fassung verwerfen und wieder die mitgelieferte
 *  benutzen. */
export async function clearGeoipTable(): Promise<void> {
  await storedRow();
  await updateDocument<GeoipRow>(COLLECTIONS.GEOIP_TABLE, 'current', {
    fetched: false,
    version: '',
    source: '',
    builtAt: '',
    uploadedAt: '',
    uploadedBy: null,
    countryCount: 0,
    v4Count: 0,
    v6Count: 0,
    payload: '',
  });
  g.__hapm_geoip = null;
}

/* ══════════════════════════════════════════════════════════════════════
 * Das selbsttätige Holen: Schalter und letzter Versuch
 * ══════════════════════════════════════════════════════════════════════ */

/** Was über das Holen dauerhaft festgehalten wird. Benutzt von `./fetch.ts`. */
export interface GeoipRefreshRecord {
  autoRefresh: boolean;
  /** Wann zuletzt versucht wurde, ISO. `null` heißt: noch nie. */
  lastAttemptAt: string | null;
  /** Woran der letzte Versuch scheiterte. `null` heißt: er ging gut, oder es
   *  gab noch keinen. */
  lastAttemptError: string | null;
}

export async function readGeoipRefresh(): Promise<GeoipRefreshRecord> {
  const row = await storedRow();
  return {
    autoRefresh: row.autoRefresh !== false,
    lastAttemptAt: row.lastAttemptAt || null,
    lastAttemptError: row.lastAttemptError || null,
  };
}

export async function writeGeoipRefresh(patch: Partial<GeoipRefreshRecord>): Promise<void> {
  await storedRow();
  await updateDocument<GeoipRow>(COLLECTIONS.GEOIP_TABLE, 'current', patch);
}
