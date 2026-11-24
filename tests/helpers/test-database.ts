import postgres from 'postgres';

/**
 * Ein eigenes Schema in dem Postgres, auf das `TEST_DATABASE_URL` zeigt.
 *
 *   docker run -d --rm --name hapm-test-pg -e POSTGRES_HOST_AUTH_METHOD=trust -p 55432:5432 postgres:17-alpine
 *   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres pnpm test
 *
 * Ohne die Variable werden die Tests gegen die Datenbank übersprungen, mit
 * einer Zeile, die sagt warum. `lib/db` liest `DATABASE_URL` beim ersten
 * Zugriff: `create` setzt sie, bevor der Test etwas aus `lib/` lädt.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export function announceSkip(name: string): void {
  console.warn(
    `[${name}] übersprungen: TEST_DATABASE_URL ist nicht gesetzt. ` +
      'Geprüft wird nur gegen ein echtes Postgres (siehe tests/helpers/test-database.ts).'
  );
}

async function admin(statement: string): Promise<void> {
  const db = postgres(TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    await db.unsafe(statement);
  } finally {
    await db.end();
  }
}

export async function createTestSchema(schema: string): Promise<void> {
  await admin(`create schema "${schema}"`);
  const url = new URL(TEST_DATABASE_URL!);
  // Jede Verbindung des Pools landet im eigenen Schema.
  url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
}

export async function dropTestSchema(schema: string): Promise<void> {
  delete process.env.DATABASE_URL;
  await admin(`drop schema if exists "${schema}" cascade`);
}
