/**
 * HAPM holt sich die Länder-Tabelle selbst.
 *
 * DB-IP veröffentlicht den Datensatz „IP to Country Lite" jeden Monat unter
 * einer Adresse, die sich aus dem Monat ergibt. Die Datei von Hand
 * herunterzuladen und hier wieder hochzuladen geht weiterhin, unterbleibt aber
 * erfahrungsgemäß. Deshalb fragt der Scheduler einmal am Tag
 * `maybeRefreshGeoip()`, und die Seite hat einen Knopf für `refreshGeoip()`.
 *
 * ── Was dabei nach außen geht ──
 *
 * Eine Anfrage nach einer Datei, deren Name nur den Monat enthält. Keine
 * Besucheradresse, keine Domain, nichts über diese Installation. Das
 * Nachschlagen selbst bleibt im Prozess (`./format.ts`), daran ändert der Abruf
 * nichts.
 *
 * ── Warum laufender Monat, sonst Vormonat ──
 *
 * DB-IP stellt die Datei am Monatsanfang ein, nicht um Mitternacht. In den
 * Stunden dazwischen antwortet die Adresse des laufenden Monats mit 404. Das
 * ist kein Fehler, sondern „noch nicht da", und dann ist der Vormonat der
 * neueste Stand, den es gibt.
 *
 * ── Warum die Weiterleitungen von Hand verfolgt werden ──
 *
 * `fetch` folgt von sich aus überallhin. Geladen wird aber nur von db-ip.com
 * und nur über https: was von dort kommt, wird zur Tabelle, aus der die
 * Statistik Länder macht. Eine Weiterleitung auf einen fremden Host wird
 * deshalb als Fehler gemeldet und nicht befolgt.
 *
 * ── Warum der letzte Versuch zweimal gemerkt wird ──
 *
 * Dauerhaft (an der Zeile der Tabelle, `./store.ts`), damit ein Container, der
 * in einer Schleife neu startet, db-ip.com nicht bei jedem Start anfragt. Und
 * im Prozess, damit die Sperre auch dann hält, wenn genau das Schreiben nicht
 * geht.
 */

import { logAudit, systemActor } from '../audit';
import { GeoTableError } from './format';
import { importGeoipFile } from './import';
import {
  geoipDownloadUrl,
  GEOIP_MAX_UPLOAD_BYTES,
  GEOIP_SOURCE_NAME,
  GEOIP_SOURCE_URL,
  GEOIP_STALE_DAYS,
} from './pack';
import {
  geoipStatus,
  readGeoipRefresh,
  writeGeoipRefresh,
  type GeoipRefreshRecord,
  type GeoipStatus,
} from './store';

export { geoipDownloadUrl };

/** Die ganze Anfrage samt Laden der 4,5 MB. Großzügig für eine langsame Leitung. */
const FETCH_TIMEOUT_MS = 120_000;

/**
 * So lange ruht `maybeRefreshGeoip` nach einem Versuch, gleich wie er ausging.
 *
 * Zehn Minuten unter 24 Stunden, und zwar mit Absicht: der Scheduler ruft
 * täglich zur selben Minute. Bei genau 24 Stunden entschieden Millisekunden, ob
 * der Aufruf von morgen noch in die Sperre von heute fällt, und dann würde nur
 * jeden zweiten Tag versucht.
 */
const RETRY_AFTER_MS = 24 * 60 * 60 * 1000 - 10 * 60 * 1000;

const MAX_REDIRECTS = 3;

export interface GeoipRefreshResult {
  ok: boolean;
  /** Der Stand, der danach gilt. `null`, wenn der Versuch scheiterte. */
  version: string | null;
  /** Ob eine neue Tabelle geschrieben wurde. */
  changed: boolean;
  /** Ein Satz für die Oberfläche. `null`, wenn es gut ging. */
  error: string | null;
}

/** Was die Oberfläche über die Tabelle und das Holen wissen muss. */
export interface GeoipOverview extends GeoipStatus, GeoipRefreshRecord {
  sourceUrl: string;
  sourceName: string;
  staleAfterDays: number;
}

/** Ein Fehler beim Abruf, mit einem Satz, der so angezeigt werden kann. */
class GeoipFetchError extends Error {}

interface RefreshMemory {
  running: Promise<GeoipRefreshResult> | null;
  /** Beginn des letzten Versuchs, ms. Daran hängt die Sperre im Prozess. */
  lastStartedAt: number | null;
  lastAttemptAt: string | null;
  lastAttemptError: string | null;
}

const g = globalThis as typeof globalThis & { __hapmGeoipRefresh?: RefreshMemory };

function memory(): RefreshMemory {
  return (g.__hapmGeoipRefresh ??= {
    running: null,
    lastStartedAt: null,
    lastAttemptAt: null,
    lastAttemptError: null,
  });
}

/* ══════════════════════════════════════════════════════════════════════
 * Monate
 * ══════════════════════════════════════════════════════════════════════ */

interface Month {
  year: number;
  month: number;
  /** So nennt DB-IP den Stand: `2026-08`. */
  version: string;
}

function toMonth(year: number, month: number): Month {
  return { year, month, version: `${year}-${String(month).padStart(2, '0')}` };
}

/** In UTC: die Datei eines Monats gibt es für alle zugleich. */
function monthOf(now: Date): Month {
  return toMonth(now.getUTCFullYear(), now.getUTCMonth() + 1);
}

function monthBefore(month: Month): Month {
  return month.month === 1 ? toMonth(month.year - 1, 12) : toMonth(month.year, month.month - 1);
}

/** Nur ein Stand in dieser Form lässt sich als Text vergleichen. */
function comparable(version: string | null): string | null {
  return version && /^\d{4}-\d{2}$/.test(version) ? version : null;
}

/* ══════════════════════════════════════════════════════════════════════
 * Laden
 * ══════════════════════════════════════════════════════════════════════ */

function assertAllowed(url: URL): void {
  if (url.protocol !== 'https:') {
    throw new GeoipFetchError(
      `db-ip.com leitet auf eine Adresse ohne https weiter (${url.protocol}//${url.host}). ` +
        'Die Datei wurde nicht geladen.'
    );
  }
  if (url.hostname !== 'db-ip.com' && !url.hostname.endsWith('.db-ip.com')) {
    throw new GeoipFetchError(
      `db-ip.com leitet auf einen fremden Server weiter (${url.hostname}). ` +
        'Die Datei wurde nicht geladen.'
    );
  }
}

function tooLarge(): GeoipFetchError {
  return new GeoipFetchError(
    `Die Datei von db-ip.com ist größer als ${Math.round(GEOIP_MAX_UPLOAD_BYTES / 1024 / 1024)} MB ` +
      'und wurde nicht geladen.'
  );
}

/** Den Rumpf lesen und abbrechen, sobald er die Grenze überschreitet. Die
 *  Längenangabe im Kopf ist eine Behauptung der Gegenseite, gezählt wird hier. */
async function readLimited(response: Response): Promise<Uint8Array> {
  const announced = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(announced) && announced > GEOIP_MAX_UPLOAD_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) return new Uint8Array(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > GEOIP_MAX_UPLOAD_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

/** Die Datei eines Monats, oder `null`, wenn DB-IP sie (noch) nicht anbietet. */
async function download(month: Month, signal: AbortSignal): Promise<Uint8Array | null> {
  let url = new URL(geoipDownloadUrl(month.year, month.month));

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertAllowed(url);
    const response = await fetch(url, { redirect: 'manual', signal });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location) {
        throw new GeoipFetchError(
          `db-ip.com antwortete mit Status ${response.status}, nannte aber kein Ziel.`
        );
      }
      url = new URL(location, url);
      continue;
    }

    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new GeoipFetchError(`db-ip.com antwortete mit Status ${response.status}.`);
    }
    return readLimited(response);
  }

  throw new GeoipFetchError('db-ip.com leitet zu oft weiter. Die Datei wurde nicht geladen.');
}

/** Aus dem, was geworfen wurde, ein Satz für die Oberfläche. */
function describeFailure(err: unknown): string {
  if (err instanceof GeoipFetchError || err instanceof GeoTableError) return err.message;

  const name = err instanceof Error ? err.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return (
      `Der Abruf von db-ip.com hat länger als ${Math.round(FETCH_TIMEOUT_MS / 1000)} Sekunden ` +
      'gedauert und wurde abgebrochen.'
    );
  }

  // `fetch` meldet jeden Netzfehler als `TypeError: fetch failed`. Der Grund
  // (kein DNS, Verbindung abgelehnt) steht in `cause`.
  if (err instanceof TypeError) {
    const cause = (err as { cause?: { code?: unknown } }).cause;
    const code = typeof cause?.code === 'string' ? ` (${cause.code})` : '';
    return `db-ip.com ist nicht erreichbar${code}. Hat dieser Server Zugang nach außen?`;
  }

  return `Der Abruf ist gescheitert: ${err instanceof Error ? err.message : String(err)}`;
}

/* ══════════════════════════════════════════════════════════════════════
 * Holen
 * ══════════════════════════════════════════════════════════════════════ */

async function fetchNewest(now: Date, actor: string | null): Promise<GeoipRefreshResult> {
  const have = comparable((await geoipStatus(now.getTime())).version);
  const current = monthOf(now);
  const candidates = [current, monthBefore(current)];
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);

  for (const candidate of candidates) {
    // Auch die mitgelieferte Fassung zählt: steht sie schon auf diesem Monat,
    // gibt es nichts zu laden. Und eine neuere wird nie durch eine ältere ersetzt.
    if (have !== null && have >= candidate.version) {
      return { ok: true, version: have, changed: false, error: null };
    }

    const bytes = await download(candidate, signal);
    if (bytes === null) continue;

    await importGeoipFile({
      bytes,
      version: candidate.version,
      uploadedBy: actor,
      fetched: true,
    });
    return { ok: true, version: candidate.version, changed: true, error: null };
  }

  throw new GeoipFetchError(
    `DB-IP bietet weder für ${candidates[0].version} noch für ${candidates[1].version} eine Datei an.`
  );
}

async function attempt(actor: string | null): Promise<GeoipRefreshResult> {
  const state = memory();
  const startedAt = new Date();
  state.lastStartedAt = startedAt.getTime();

  let result: GeoipRefreshResult;
  try {
    result = await fetchNewest(startedAt, actor);
  } catch (err) {
    result = { ok: false, version: null, changed: false, error: describeFailure(err) };
  }

  state.lastAttemptAt = startedAt.toISOString();
  state.lastAttemptError = result.error;
  try {
    await writeGeoipRefresh({
      lastAttemptAt: state.lastAttemptAt,
      lastAttemptError: state.lastAttemptError,
    });
  } catch (err) {
    console.error('[geoip] Letzter Versuch nicht gespeichert:', err);
  }
  return result;
}

/**
 * Die neueste Datei holen und zur gültigen Tabelle machen.
 *
 * Wirft nie: woran es scheiterte, steht in `error`. Steht die vorhandene
 * Tabelle schon auf dem neuesten Monat, wird nichts geladen und nichts
 * geschrieben (`changed: false`).
 *
 * `actor` ist, wer den Abruf ausgelöst hat. Ohne ihn gilt er als selbsttätig.
 * Läuft schon ein Abruf, bekommt der zweite Aufrufer dessen Ergebnis.
 */
export function refreshGeoip(options: { actor?: string } = {}): Promise<GeoipRefreshResult> {
  const state = memory();
  if (state.running) return state.running;

  const run = attempt(options.actor ?? null).finally(() => {
    state.running = null;
  });
  state.running = run;
  return run;
}

function withinRetry(at: number | null, now: number): boolean {
  // Ein Zeitpunkt in der Zukunft (Uhr verstellt) sperrt nicht.
  return at !== null && Number.isFinite(at) && now >= at && now - at < RETRY_AFTER_MS;
}

/**
 * Für den Scheduler: holen, falls es etwas zu holen gibt.
 *
 * Tut nichts, wenn das selbsttätige Holen abgeschaltet ist, wenn die Tabelle
 * vom laufenden Monat ist oder wenn der letzte Versuch keinen Tag her ist
 * (`RETRY_AFTER_MS`). Darf deshalb beliebig oft gerufen werden. Wirft nie.
 *
 * `null` heißt: es gab nichts zu tun.
 */
export async function maybeRefreshGeoip(): Promise<GeoipRefreshResult | null> {
  try {
    const now = Date.now();
    const state = memory();
    if (state.running || withinRetry(state.lastStartedAt, now)) return null;

    const stored = await readGeoipRefresh();
    if (!stored.autoRefresh) return null;
    if (withinRetry(stored.lastAttemptAt ? Date.parse(stored.lastAttemptAt) : null, now)) return null;

    const have = comparable((await geoipStatus(now)).version);
    if (have !== null && have >= monthOf(new Date(now)).version) return null;

    const result = await refreshGeoip();
    if (!result.ok) {
      console.error(`[geoip] Selbsttätiger Abruf gescheitert: ${result.error}`);
    } else if (result.changed) {
      await logAudit({
        ...systemActor(),
        action: 'geoip_table_updated',
        resource: 'settings',
        resourceId: 'geoip',
        details: `Länder-Tabelle selbsttätig von db-ip.com geholt, Stand ${result.version}`,
      });
    }
    return result;
  } catch (err) {
    console.error('[geoip] Selbsttätiger Abruf abgebrochen:', err);
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * Schalter und Auskunft
 * ══════════════════════════════════════════════════════════════════════ */

export async function setGeoipAutoRefresh(enabled: boolean): Promise<void> {
  await writeGeoipRefresh({ autoRefresh: enabled });
}

/** Der Zustand für Einstellungsseite und Hinweis: Tabelle, Schalter, letzter
 *  Versuch. Vom letzten Versuch gilt der jüngere aus Prozess und Datenbank. */
export async function geoipOverview(): Promise<GeoipOverview> {
  const [status, stored] = await Promise.all([geoipStatus(), readGeoipRefresh()]);
  const state = memory();
  const fromMemory =
    state.lastAttemptAt !== null &&
    (stored.lastAttemptAt === null || state.lastAttemptAt > stored.lastAttemptAt);

  return {
    ...status,
    autoRefresh: stored.autoRefresh,
    lastAttemptAt: fromMemory ? state.lastAttemptAt : stored.lastAttemptAt,
    lastAttemptError: fromMemory ? state.lastAttemptError : stored.lastAttemptError,
    sourceUrl: GEOIP_SOURCE_URL,
    sourceName: GEOIP_SOURCE_NAME,
    staleAfterDays: GEOIP_STALE_DAYS,
  };
}
