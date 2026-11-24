import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL, announceSkip, createTestSchema, dropTestSchema } from '../helpers/test-database';

/**
 * Die Fassade gegen ein echtes Postgres.
 *
 * Die Module darüber verlassen sich auf ihr Verhalten, ohne es zu prüfen:
 * 25 Zeilen ohne Limit, `listAll` über alle Seiten, `update` mischt statt zu
 * ersetzen, ein fehlendes Dokument wirft `NotFoundError`.
 *
 * Läuft nur, wenn `TEST_DATABASE_URL` auf ein Postgres zeigt, das dafür da ist
 * (`tests/helpers/test-database.ts`): der Test legt ein eigenes Schema an und
 * räumt es wieder ab.
 */

const SCHEMA = `hapm_test_driver_${process.pid}`;

type Db = typeof import('@/lib/db');
type Driver = typeof import('@/lib/db/postgres-driver');
let db: Db;
let driver: Driver;

const RUNS = 'haproxy_runs';

interface Run {
  serviceId: string;
  status: string;
  startedAt: string;
  acknowledged: boolean | null;
  duration: number | null;
  note?: string;
}

const suite = TEST_DATABASE_URL ? describe : describe.skip;
if (!TEST_DATABASE_URL) announceSkip('tests/db/driver');

suite('postgres-Treiber', () => {
  beforeAll(async () => {
    await createTestSchema(SCHEMA);
    db = await import('@/lib/db');
    driver = await import('@/lib/db/postgres-driver');

    for (let i = 0; i < 40; i++) {
      await db.createDocument<Run>(RUNS, {
        serviceId: `dienst_${String(i).padStart(2, '0')}`,
        status: i % 4 === 0 ? 'error' : 'success',
        startedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        acknowledged: i % 8 === 0 ? true : i % 4 === 0 ? false : null,
        duration: i,
        // Bei jedem zweiten fehlt das Feld ganz, statt `null` zu sein.
        ...(i % 2 === 0 ? { note: `Notiz ${i}` } : {}),
      });
    }
  });

  afterAll(async () => {
    await driver.closeDatabase();
    await dropTestSchema(SCHEMA);
  });

  it('liefert ohne Limit 25 Zeilen und mit listAll alle', async () => {
    expect(await db.listDocuments<Run>(RUNS)).toHaveLength(25);
    expect(await db.listAll<Run>(RUNS)).toHaveLength(40);
  });

  it('gibt Kennung und Zeitstempel als Text in ISO-Form zurück', async () => {
    const [row] = await db.listDocuments<Run>(RUNS, [db.Query.limit(1)]);
    expect(row.$id).toMatch(/^[0-9a-f]{32}$/);
    expect(row.$createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(row.$createdAt).toISOString()).toBe(row.$createdAt);
    expect(row.$updatedAt).toBe(row.$createdAt);
    // Die Meta-Felder stehen nicht noch einmal im Dokument.
    const again = await db.updateDocument<Run>(RUNS, row.$id, { ...row });
    expect(Object.keys(again).filter((key) => key.startsWith('$')).sort()).toEqual([
      '$createdAt',
      '$id',
      '$updatedAt',
    ]);
  });

  it('filtert, sortiert und begrenzt', async () => {
    const rows = await db.listDocuments<Run>(RUNS, [
      db.Query.equal('status', 'error'),
      db.Query.orderDesc('startedAt'),
      db.Query.limit(3),
    ]);
    expect(rows.map((r) => r.serviceId)).toEqual(['dienst_36', 'dienst_32', 'dienst_28']);
  });

  it('blättert mit offset', async () => {
    const rows = await db.listDocuments<Run>(RUNS, [
      db.Query.orderAsc('startedAt'),
      db.Query.limit(2),
      db.Query.offset(3),
    ]);
    expect(rows.map((r) => r.serviceId)).toEqual(['dienst_03', 'dienst_04']);
  });

  it('sortiert Zahlen als Zahlen', async () => {
    const rows = await db.listDocuments<Run>(RUNS, [db.Query.orderDesc('duration'), db.Query.limit(3)]);
    expect(rows.map((r) => r.duration)).toEqual([39, 38, 37]);
    const asc = await db.listDocuments<Run>(RUNS, [
      db.Query.greaterThanEqual('duration', 8),
      db.Query.orderAsc('duration'),
      db.Query.limit(3),
    ]);
    // Als Text stünde 10 vor 8.
    expect(asc.map((r) => r.duration)).toEqual([8, 9, 10]);
  });

  it('vergleicht Zahlen als Zahlen und Zeitstempel als Text', async () => {
    const late = await db.listAll<Run>(RUNS, [db.Query.greaterThanEqual('duration', 38)]);
    expect(late.map((r) => r.duration).sort()).toEqual([38, 39]);
    // Als Text wäre '9' größer als '10'.
    expect(await db.listAll<Run>(RUNS, [db.Query.lessThan('duration', 10)])).toHaveLength(10);
    expect(await db.listAll<Run>(RUNS, [db.Query.equal('duration', 7)])).toHaveLength(1);
    const early = await db.listAll<Run>(RUNS, [
      db.Query.lessThan('startedAt', new Date(Date.UTC(2026, 0, 1, 0, 2)).toISOString()),
    ]);
    expect(early).toHaveLength(2);
    expect(
      await db.listAll<Run>(RUNS, [
        db.Query.greaterThan('startedAt', new Date(Date.UTC(2026, 0, 1, 0, 37)).toISOString()),
        db.Query.lessThanEqual('startedAt', new Date(Date.UTC(2026, 0, 1, 0, 39)).toISOString()),
      ])
    ).toHaveLength(2);
  });

  it('kennt Wahrheitswerte, fehlende Werte und Listen', async () => {
    expect(await db.listAll<Run>(RUNS, [db.Query.equal('acknowledged', true)])).toHaveLength(5);
    expect(await db.listAll<Run>(RUNS, [db.Query.equal('acknowledged', false)])).toHaveLength(5);
    expect(await db.listAll<Run>(RUNS, [db.Query.isNull('acknowledged')])).toHaveLength(30);
    expect(await db.listAll<Run>(RUNS, [db.Query.isNotNull('acknowledged')])).toHaveLength(10);
    // „ungleich" schließt fehlende Werte ein.
    expect(await db.listAll<Run>(RUNS, [db.Query.notEqual('acknowledged', true)])).toHaveLength(35);
    expect(
      await db.listAll<Run>(RUNS, [db.Query.equal('serviceId', ['dienst_01', 'dienst_02', 'gibt_es_nicht'])])
    ).toHaveLength(2);
    expect(await db.listAll<Run>(RUNS, [db.Query.equal('duration', [1, 2, 99])])).toHaveLength(2);
    expect(await db.listAll<Run>(RUNS, [db.Query.equal('serviceId', [])])).toHaveLength(0);
  });

  it('behandelt ein fehlendes Feld wie null', async () => {
    expect(await db.listAll<Run>(RUNS, [db.Query.isNull('note')])).toHaveLength(20);
    expect(await db.listAll<Run>(RUNS, [db.Query.isNotNull('note')])).toHaveLength(20);
    expect(await db.listAll<Run>(RUNS, [db.Query.notEqual('note', 'Notiz 0')])).toHaveLength(39);
    expect(await db.listAll<Run>(RUNS, [db.Query.notEqual('duration', 0)])).toHaveLength(39);
  });

  it('mischt beim Ändern und lässt die übrigen Felder stehen', async () => {
    const [first] = await db.listDocuments<Run>(RUNS, [db.Query.equal('serviceId', 'dienst_05')]);
    const updated = await db.updateDocument<Run>(RUNS, first.$id, { status: 'warning' });
    expect(updated.status).toBe('warning');
    expect(updated.serviceId).toBe('dienst_05');
    expect(updated.$id).toBe(first.$id);
    expect(updated.$createdAt).toBe(first.$createdAt);
    expect(updated.$updatedAt >= first.$updatedAt).toBe(true);

    // `undefined` lässt ein Feld stehen, `null` überschreibt es.
    const kept = await db.updateDocument<Run>(RUNS, first.$id, { status: undefined, duration: null });
    expect(kept.status).toBe('warning');
    expect(kept.duration).toBeNull();
    await db.updateDocument<Run>(RUNS, first.$id, { status: 'success', duration: 5 });
  });

  it('speichert Text mit Sonderzeichen unverändert', async () => {
    const text = `O'Brien; drop table "haproxy_runs"; -- $1 \\ ü 🙂\n`;
    const created = await db.createDocument<Run>(RUNS, {
      serviceId: text,
      status: 'special',
      startedAt: '2025-01-01T00:00:00.000Z',
      acknowledged: null,
      duration: null,
    });
    expect((await db.getDocument<Run>(RUNS, created.$id)).serviceId).toBe(text);
    expect(await db.listAll<Run>(RUNS, [db.Query.equal('serviceId', text)])).toHaveLength(1);
    await db.deleteDocument(RUNS, created.$id);
    await expect(db.getDocument(RUNS, created.$id)).rejects.toBeInstanceOf(db.NotFoundError);
  });

  it('wirft NotFoundError für ein fehlendes Dokument', async () => {
    await expect(db.getDocument(RUNS, 'gibt-es-nicht')).rejects.toBeInstanceOf(db.NotFoundError);
    await expect(db.updateDocument(RUNS, 'gibt-es-nicht', {})).rejects.toBeInstanceOf(db.NotFoundError);
  });

  it('legt eine Einzelzeile an und liest sie beim zweiten Mal', async () => {
    const created = await db.getSingleton<{ acmeEmail: string | null }>('settings', 'main', { acmeEmail: null });
    expect(created.acmeEmail).toBeNull();
    await db.updateDocument('settings', 'main', { acmeEmail: 'a@example.org' });
    const again = await db.getSingleton<{ acmeEmail: string | null }>('settings', 'main', { acmeEmail: null });
    expect(again.acmeEmail).toBe('a@example.org');
    // Eine vergebene Kennung ein zweites Mal anzulegen ist ein Fehler, kein Überschreiben.
    await expect(db.createDocument('settings', { acmeEmail: 'b@example.org' }, 'main')).rejects.toThrow();
  });

  it('löscht nach Bedingung und hält sich an das Limit', async () => {
    const removed = await db.deleteWhere(RUNS, [db.Query.equal('status', 'success'), db.Query.limit(10)]);
    expect(removed).toBe(10);
    const rest = await db.deleteWhere(RUNS, [db.Query.equal('status', 'success')]);
    expect(rest).toBe(20);
    expect(await db.listAll<Run>(RUNS, [db.Query.equal('status', 'success')])).toHaveLength(0);
    expect(await db.listAll<Run>(RUNS)).toHaveLength(10);
  });

  it('lehnt unbekannte Collections, unzulässige Feldnamen und ein Löschen ohne Bedingung ab', async () => {
    await expect(db.listDocuments('gibt_es_nicht')).rejects.toThrow(/Unbekannte Collection/);
    await expect(db.listDocuments(RUNS, [db.Query.equal("x') OR 1=1 --", 1)])).rejects.toThrow(/Feldname/);
    await expect(db.listDocuments(RUNS, [db.Query.orderAsc('a"b')])).rejects.toThrow(/Feldname/);
    await expect(db.deleteWhere(RUNS, [db.Query.limit(5)])).rejects.toThrow(/ohne Bedingung/);
  });

  it('legt die Indizes aus INDEXES an', async () => {
    const rows = await driver.sql()<{ indexname: string }[]>`
      select indexname from pg_indexes where schemaname = ${SCHEMA} and tablename = ${RUNS}
    `;
    expect(rows.map((r) => r.indexname).sort()).toEqual([
      'haproxy_runs_pkey',
      'idx_haproxy_runs_serviceId',
      'idx_haproxy_runs_startedAt',
      'idx_haproxy_runs_status',
    ]);
  });
});
