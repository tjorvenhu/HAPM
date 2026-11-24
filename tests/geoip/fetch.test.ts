import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { TEST_DATABASE_URL, announceSkip, createTestSchema, dropTestSchema } from '../helpers/test-database';

/**
 * Der eigene Abruf der Länder-Tabelle.
 *
 * Kein Netz: `fetch` ist untergeschoben und führt Buch, wonach gefragt wurde.
 * Die Datenbank dagegen ist echt (ein eigenes Schema in dem Postgres, auf das
 * `TEST_DATABASE_URL` zeigt), weil genau das geprüft werden soll, was über einen
 * Neustart hinweg hält: der Stand, der Schalter und der letzte Versuch. Ohne
 * die Variable laufen nur die Fälle, die keine Datenbank brauchen.
 *
 * Die Uhr steht in jedem Test auf einem Tag weit hinter dem mitgelieferten
 * Stand. Sonst entschiede das Datum des Testlaufs, ob es etwas zu holen gibt.
 */

type Fetch = typeof import('@/lib/geoip/fetch');
type Store = typeof import('@/lib/geoip/store');

let geoip: Fetch;
let store: Store;
let dir: string;

const SCHEMA = `hapm_test_geoip_${process.pid}`;
const describeWithDatabase = TEST_DATABASE_URL ? describe : describe.skip;
if (!TEST_DATABASE_URL) announceSkip('tests/geoip/fetch');

/** Ein Datensatz, der die Prüfung „mindestens 1000 Bereiche je Familie" besteht.
 *  Die Länder wechseln, sonst fielen die Nachbarn zu einem Bereich zusammen. */
function dataset(): Uint8Array {
  const lines: string[] = [];
  for (let i = 0; i < 1200; i++) {
    const code = i % 2 === 0 ? 'DE' : 'FR';
    const block = `${i >> 8}.${i & 255}`;
    lines.push(`10.${block}.0,10.${block}.255,${code}`);
    const group = (i + 1).toString(16);
    lines.push(`2a00:${group}::,2a00:${group}:ffff:ffff:ffff:ffff:ffff:ffff,${code}`);
  }
  return gzipSync(Buffer.from(lines.join('\n'), 'utf8'));
}

const FILE = dataset();

/** Was `fetch` je Monat antwortet. Ein Monat, der hier fehlt, ist ein 404. */
type Answer = 'file' | Response | Error;
let answers: Record<string, Answer>;
let asked: string[];

function monthIn(url: string): string {
  return /(\d{4}-\d{2})\.csv\.gz$/.exec(url)?.[1] ?? url;
}

function at(iso: string): void {
  vi.setSystemTime(new Date(iso));
}

function forgetProcessMemory(): void {
  delete (globalThis as { __hapmGeoipRefresh?: unknown }).__hapmGeoipRefresh;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hapm-geoip-'));
  process.env.HAPM_DATA_DIR = dir;
  if (TEST_DATABASE_URL) await createTestSchema(SCHEMA);
  geoip = await import('@/lib/geoip/fetch');
  store = await import('@/lib/geoip/store');
});

afterAll(async () => {
  if (TEST_DATABASE_URL) {
    await (await import('@/lib/db/postgres-driver')).closeDatabase();
    await dropTestSchema(SCHEMA);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Nur die Uhr: `fetch` und die Datenbank sollen mit echten Zeitgebern laufen.
  vi.useFakeTimers({ toFake: ['Date'] });
  answers = {};
  asked = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      asked.push(url);
      const answer = answers[monthIn(url)];
      if (answer instanceof Error) throw answer;
      if (answer instanceof Response) return answer;
      if (answer === 'file') return new Response(Buffer.from(FILE), { status: 200 });
      return new Response('nicht da', { status: 404 });
    })
  );
  vi.spyOn(console, 'error').mockImplementation(() => undefined);

  forgetProcessMemory();
  if (!TEST_DATABASE_URL) return;
  await store.clearGeoipTable();
  await store.writeGeoipRefresh({ autoRefresh: true, lastAttemptAt: null, lastAttemptError: null });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('geoipDownloadUrl', () => {
  it('baut die Adresse aus Jahr und Monat', () => {
    expect(geoip.geoipDownloadUrl(2026, 11)).toBe(
      'https://download.db-ip.com/free/dbip-country-lite-2026-11.csv.gz'
    );
  });

  it('schreibt den Monat zweistellig', () => {
    expect(geoip.geoipDownloadUrl(2027, 3)).toBe(
      'https://download.db-ip.com/free/dbip-country-lite-2027-03.csv.gz'
    );
  });

  it('weist ab, was kein Monat ist', () => {
    expect(() => geoip.geoipDownloadUrl(2026, 0)).toThrow(RangeError);
    expect(() => geoip.geoipDownloadUrl(2026, 13)).toThrow(RangeError);
    expect(() => geoip.geoipDownloadUrl(2026, 1.5)).toThrow(RangeError);
    expect(() => geoip.geoipDownloadUrl(26, 1)).toThrow(RangeError);
  });
});

describeWithDatabase('refreshGeoip: welcher Monat', () => {
  it('holt die Datei des laufenden Monats', async () => {
    at('2031-03-15T10:00:00Z');
    answers['2031-03'] = 'file';

    const result = await geoip.refreshGeoip({ actor: 'admin@example.org' });

    expect(result).toEqual({ ok: true, version: '2031-03', changed: true, error: null });
    expect(asked.map(monthIn)).toEqual(['2031-03']);

    const overview = await geoip.geoipOverview();
    expect(overview.origin).toBe('fetched');
    expect(overview.version).toBe('2031-03');
    expect(overview.uploadedBy).toBe('admin@example.org');
    expect(overview.lastAttemptAt).toBe('2031-03-15T10:00:00.000Z');
    expect(overview.lastAttemptError).toBeNull();
  });

  it('nimmt den Vormonat, solange es den laufenden noch nicht gibt', async () => {
    at('2031-05-01T00:30:00Z');
    answers['2031-04'] = 'file';

    const result = await geoip.refreshGeoip();

    expect(result).toEqual({ ok: true, version: '2031-04', changed: true, error: null });
    expect(asked.map(monthIn)).toEqual(['2031-05', '2031-04']);
  });

  it('geht im Januar auf den Dezember des Vorjahres zurück', async () => {
    at('2032-01-01T02:00:00Z');
    answers['2031-12'] = 'file';

    const result = await geoip.refreshGeoip();

    expect(result.version).toBe('2031-12');
    expect(asked.map(monthIn)).toEqual(['2032-01', '2031-12']);
  });

  it('meldet einen Fehler, wenn es keinen der beiden Monate gibt', async () => {
    at('2031-05-01T00:30:00Z');

    const result = await geoip.refreshGeoip();

    expect(result.ok).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.error).toContain('2031-05');
    expect(result.error).toContain('2031-04');
    expect((await geoip.geoipOverview()).lastAttemptError).toBe(result.error);
  });
});

describeWithDatabase('refreshGeoip: nichts tun, wenn aktuell', () => {
  it('fragt nicht an, wenn die Tabelle vom laufenden Monat ist', async () => {
    at('2031-03-15T10:00:00Z');
    answers['2031-03'] = 'file';
    await geoip.refreshGeoip();
    const before = await geoip.geoipOverview();
    asked = [];

    at('2031-03-20T10:00:00Z');
    const result = await geoip.refreshGeoip();

    expect(result).toEqual({ ok: true, version: '2031-03', changed: false, error: null });
    expect(asked).toEqual([]);
    expect((await geoip.geoipOverview()).uploadedAt).toBe(before.uploadedAt);
  });

  it('lädt den Vormonat nicht noch einmal, wenn er schon da ist', async () => {
    at('2031-04-20T10:00:00Z');
    answers['2031-04'] = 'file';
    await geoip.refreshGeoip();
    const before = await geoip.geoipOverview();
    asked = [];

    at('2031-05-01T00:30:00Z');
    const result = await geoip.refreshGeoip();

    expect(result).toEqual({ ok: true, version: '2031-04', changed: false, error: null });
    // Nur die Frage nach dem neuen Monat, kein zweites Laden des alten.
    expect(asked.map(monthIn)).toEqual(['2031-05']);
    expect((await geoip.geoipOverview()).uploadedAt).toBe(before.uploadedAt);
  });
});

describeWithDatabase('refreshGeoip: was nicht geladen wird', () => {
  it('folgt keiner Weiterleitung auf einen fremden Host', async () => {
    at('2031-03-15T10:00:00Z');
    answers['2031-03'] = new Response(null, {
      status: 302,
      headers: { location: 'https://example.org/dbip-country-lite-2031-03.csv.gz' },
    });

    const result = await geoip.refreshGeoip();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('example.org');
    expect(asked).toHaveLength(1);
  });

  it('folgt keiner Weiterleitung ohne https', async () => {
    at('2031-03-15T10:00:00Z');
    answers['2031-03'] = new Response(null, {
      status: 301,
      headers: { location: 'http://download.db-ip.com/free/dbip-country-lite-2031-03.csv.gz' },
    });

    const result = await geoip.refreshGeoip();

    expect(result.ok).toBe(false);
    expect(asked).toHaveLength(1);
  });

  it('folgt einer Weiterleitung innerhalb von db-ip.com', async () => {
    at('2031-03-15T10:00:00Z');
    answers['2031-03'] = new Response(null, {
      status: 302,
      headers: { location: 'https://cdn.db-ip.com/free/2031-03.csv.gz?weiter=1' },
    });
    answers['https://cdn.db-ip.com/free/2031-03.csv.gz?weiter=1'] = 'file';

    const result = await geoip.refreshGeoip();

    expect(result).toEqual({ ok: true, version: '2031-03', changed: true, error: null });
    expect(asked).toHaveLength(2);
  });

  it('bricht ab, wenn die Datei größer ist als erlaubt', async () => {
    at('2031-03-15T10:00:00Z');
    answers['2031-03'] = new Response('x', {
      status: 200,
      headers: { 'content-length': String(64 * 1024 * 1024) },
    });

    const result = await geoip.refreshGeoip();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('größer');
  });

  it('nimmt keine Datei, aus der keine Bereiche werden', async () => {
    at('2031-03-15T10:00:00Z');
    answers['2031-03'] = new Response('<html>Wartung</html>', { status: 200 });

    const result = await geoip.refreshGeoip();

    expect(result.ok).toBe(false);
    expect((await geoip.geoipOverview()).origin).not.toBe('fetched');
  });

  it('sagt in klaren Worten, wenn der Server nicht nach außen kommt', async () => {
    at('2031-03-15T10:00:00Z');
    answers['2031-03'] = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ENOTFOUND' },
    });

    const result = await geoip.refreshGeoip();

    expect(result).toEqual({
      ok: false,
      version: null,
      changed: false,
      error: 'db-ip.com ist nicht erreichbar (ENOTFOUND). Hat dieser Server Zugang nach außen?',
    });
  });
});

describeWithDatabase('maybeRefreshGeoip', () => {
  it('holt, wenn die Tabelle älter ist als der laufende Monat', async () => {
    at('2031-03-15T03:17:00Z');
    answers['2031-03'] = 'file';

    const result = await geoip.maybeRefreshGeoip();

    expect(result).toEqual({ ok: true, version: '2031-03', changed: true, error: null });
    // Selbsttätig geholt: niemand hat es ausgelöst.
    expect((await geoip.geoipOverview()).uploadedBy).toBeNull();
  });

  it('tut nichts, wenn das selbsttätige Holen abgeschaltet ist', async () => {
    at('2031-03-15T03:17:00Z');
    answers['2031-03'] = 'file';
    await geoip.setGeoipAutoRefresh(false);

    expect(await geoip.maybeRefreshGeoip()).toBeNull();
    expect(asked).toEqual([]);
    expect((await geoip.geoipOverview()).autoRefresh).toBe(false);
  });

  it('tut nichts, wenn die Tabelle vom laufenden Monat ist', async () => {
    at('2031-03-15T03:17:00Z');
    answers['2031-03'] = 'file';
    await geoip.refreshGeoip();
    asked = [];

    // Auch ohne Sperre: zwei Tage später und mit leerem Prozess.
    at('2031-03-17T03:17:00Z');
    forgetProcessMemory();

    expect(await geoip.maybeRefreshGeoip()).toBeNull();
    expect(asked).toEqual([]);
  });

  it('wartet nach einem Versuch einen Tag', async () => {
    at('2031-06-01T03:17:00Z');
    const first = await geoip.maybeRefreshGeoip();
    expect(first?.ok).toBe(false);
    expect(asked.map(monthIn)).toEqual(['2031-06', '2031-05']);
    asked = [];

    for (const later of ['2031-06-01T03:18:00Z', '2031-06-01T15:00:00Z', '2031-06-02T03:00:00Z']) {
      at(later);
      expect(await geoip.maybeRefreshGeoip()).toBeNull();
    }
    expect(asked).toEqual([]);

    // Der tägliche Aufruf zur selben Minute, ein paar Millisekunden zu früh:
    // er darf nicht an der Sperre von gestern hängenbleiben.
    at('2031-06-02T03:16:59.900Z');
    answers['2031-06'] = 'file';
    const second = await geoip.maybeRefreshGeoip();
    expect(second).toEqual({ ok: true, version: '2031-06', changed: true, error: null });
    expect((await geoip.geoipOverview()).lastAttemptError).toBeNull();
  });

  it('hält die Sperre über einen Neustart', async () => {
    at('2031-06-01T03:17:00Z');
    await geoip.maybeRefreshGeoip();
    asked = [];

    // Ein neuer Prozess weiß nichts mehr, die Datenbank schon.
    forgetProcessMemory();
    at('2031-06-01T09:00:00Z');

    expect(await geoip.maybeRefreshGeoip()).toBeNull();
    expect(asked).toEqual([]);
    const overview = await geoip.geoipOverview();
    expect(overview.lastAttemptAt).toBe('2031-06-01T03:17:00.000Z');
    expect(overview.lastAttemptError).toContain('2031-06');
  });

  it('hält die Sperre im Prozess, auch wenn der Versuch nicht gespeichert wurde', async () => {
    at('2031-06-01T03:17:00Z');
    await geoip.maybeRefreshGeoip();
    await store.writeGeoipRefresh({ lastAttemptAt: null, lastAttemptError: null });
    asked = [];

    at('2031-06-01T09:00:00Z');
    expect(await geoip.maybeRefreshGeoip()).toBeNull();
    expect(asked).toEqual([]);
  });

  it('wirft nie', async () => {
    at('2031-06-01T03:17:00Z');
    answers['2031-06'] = new Error('irgendetwas');

    const result = await geoip.maybeRefreshGeoip();

    expect(result?.ok).toBe(false);
    expect(result?.error).toContain('irgendetwas');
  });
});
