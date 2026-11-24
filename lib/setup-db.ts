/**
 * Die Datenbank beim Start: warten, bis Postgres antwortet, dann die Tabellen
 * sicherstellen.
 *
 * Compose startet HAPM erst, wenn Postgres gesund ist. Verlassen kann sich der
 * Start darauf nicht: nach einem Neustart des Servers oder einem Update von
 * Postgres kommt HAPM manchmal zuerst hoch. Deshalb wird gewartet und nicht
 * beim ersten Fehlversuch aufgegeben.
 */

import { ensureAuthTables } from './db/auth-tables';
import { databaseTarget, ensureCollections, sql } from './db/postgres-driver';

export interface DatabaseState {
  status: 'pending' | 'ok' | 'error';
  error: string | null;
}

// Die Health-Route und der Start laufen in getrennt gebauten Modulen.
const globalState = globalThis as unknown as { __hapmDatabase?: DatabaseState };

export function databaseState(): DatabaseState {
  globalState.__hapmDatabase ??= { status: 'pending', error: null };
  return globalState.__hapmDatabase;
}

const WAIT_MS = 60_000;
const RETRY_MS = 1_000;

function describeTarget(): string {
  const target = databaseTarget();
  if ('url' in target) return 'die Adresse aus DATABASE_URL';
  return `den Socket unter ${target.host} (Datenbank ${target.database}, Benutzer ${target.username})`;
}

export async function waitForDatabase(timeoutMs = WAIT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  let announced = false;

  for (;;) {
    try {
      await sql()`select 1`;
      return;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) break;
    if (!announced) {
      console.log(`[db] Warte auf Postgres über ${describeTarget()} …`);
      announced = true;
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `Postgres ist nach ${Math.round(timeoutMs / 1000)} Sekunden nicht erreichbar über ${describeTarget()}: ${reason}. ` +
      `Läuft der Container ${process.env.HAPM_POSTGRES_CONTAINER || 'hapm-postgres'}, und bindet HAPM ` +
      'dessen Ordner mit dem Socket unter /var/run/postgresql ein?'
  );
}

/** Wirft nicht: das Ergebnis steht im Zustand, den auch `/api/health` liest. */
export async function ensureDatabase(): Promise<DatabaseState> {
  const state = databaseState();
  try {
    await waitForDatabase();
    await ensureCollections();
    await ensureAuthTables();
    state.status = 'ok';
    state.error = null;
  } catch (err) {
    state.status = 'error';
    state.error = err instanceof Error ? err.message : String(err);
  }
  return state;
}
