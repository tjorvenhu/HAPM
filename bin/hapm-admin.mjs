#!/usr/bin/env node
// @ts-check
/**
 * Der Weg zurück, wenn sich niemand mehr anmelden kann.
 *
 *   docker exec -it hapm hapm-admin users
 *   docker exec -it hapm hapm-admin reset-password <e-mail>
 *
 * `reset-password` setzt ein neues, zufälliges Passwort, schaltet den zweiten
 * Faktor des Kontos ab, entfernt seine Passkeys und beendet seine Sitzungen.
 * Das neue Passwort steht danach einmal in der Ausgabe. Die
 * Wiederherstellungscodes liegen in derselben Zeile von `two_factor` und gehen
 * mit ihr: sie sind der Weg ohne Server, dieses Kommando der danach.
 *
 * Wer dieses Kommando ausführen kann, hat ohnehin root auf dem Server: es ist
 * kein zusätzlicher Zugang, nur der kürzere Weg als ein Eingriff in die
 * Datenbank von Hand. Es ist der Notweg ohne Mail: „Passwort vergessen" auf der
 * Anmeldeseite braucht ein eingerichtetes SMTP-Konto und ersetzt nur das
 * Passwort.
 *
 * Reines JavaScript ohne Build, wie `hapm-ctl.mjs`. Die Verbindung ist die aus
 * `lib/db/postgres-driver.ts`, die Tabellen sind die aus `lib/db/auth-tables.ts`
 * und `lib/db/sql.ts` (`two_factor` als Dokument): wer dort etwas ändert,
 * ändert es hier mit.
 */

import postgres from 'postgres';
import { hashPassword, newPassword } from './admin-password.mjs';

/** Postgres: undefined_table. HAPM legt die Tabellen beim ersten Start an. */
const UNDEFINED_TABLE = '42P01';

function connect() {
  const options = { max: 1, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} };
  if (process.env.DATABASE_URL) return postgres(process.env.DATABASE_URL, options);
  return postgres({
    host: process.env.HAPM_DATABASE_SOCKET || '/var/run/postgresql',
    database: process.env.HAPM_DATABASE_NAME || 'hapm',
    username: process.env.HAPM_DATABASE_USER || 'hapm',
    ...options,
  });
}

/**
 * @template T
 * @param {() => Promise<T>} query
 * @param {T} fallback
 * @returns {Promise<T>}
 */
async function orIfMissing(query, fallback) {
  try {
    return await query();
  } catch (err) {
    if (/** @type {{ code?: string }} */ (err)?.code === UNDEFINED_TABLE) return fallback;
    throw err;
  }
}

/** @param {ReturnType<typeof postgres>} db */
async function users(db) {
  const rows = await orIfMissing(
    () => db`select id, email, name from auth_users order by email`,
    /** @type {any[]} */ ([])
  );
  if (rows.length === 0) {
    console.log('Es gibt noch kein Konto. Die Oberfläche fragt beim ersten Aufruf danach.');
    return 0;
  }
  const withTotp = await orIfMissing(
    () => db`select data->>'userId' as user_id from two_factor where data->'enabled' = 'true'::jsonb`,
    /** @type {any[]} */ ([])
  );
  const passkeys = await orIfMissing(
    () => db`select user_id, count(*)::int as count from auth_passkeys group by user_id`,
    /** @type {any[]} */ ([])
  );
  const totp = new Set(withTotp.map((row) => row.user_id));
  const counts = new Map(passkeys.map((row) => [row.user_id, row.count]));

  for (const row of rows) {
    console.log(
      `${row.email}  ${row.name}  zweiter Faktor: ${totp.has(row.id) ? 'ja' : 'nein'}  Passkeys: ${counts.get(row.id) ?? 0}`
    );
  }
  return 0;
}

/**
 * @param {ReturnType<typeof postgres>} db
 * @param {string | undefined} email
 */
async function resetPassword(db, email) {
  if (!email) {
    console.error('Aufruf: hapm-admin reset-password <e-mail>');
    return 2;
  }
  const wanted = email.trim().toLowerCase();
  const found = await orIfMissing(
    () => db`select id from auth_users where lower(email) = ${wanted}`,
    /** @type {any[]} */ ([])
  );
  if (found.length === 0) {
    console.error(`Kein Konto mit der Adresse ${wanted}. Vorhandene Konten zeigt "hapm-admin users".`);
    return 1;
  }
  const userId = found[0].id;

  const password = newPassword();
  const hash = await hashPassword(password);

  // Alles oder nichts: ein neues Passwort neben einem Passkey, der weiter
  // anmeldet, wäre genau der Zugang, den das Kommando schließen soll.
  await db.begin(async (tx) => {
    const updated = await tx`
      update auth_accounts set password = ${hash}, updated_at = now()
      where user_id = ${userId} and provider_id = 'credential'
    `;
    if (updated.count === 0) {
      // Wie Better-Auth selbst: bei E-Mail und Passwort ist die Kennung des
      // Zugangs die des Kontos.
      await tx`
        insert into auth_accounts (id, account_id, provider_id, user_id, password)
        values (${`admin-${Date.now().toString(36)}`}, ${userId}, 'credential', ${userId}, ${hash})
      `;
    }
    await tx`delete from auth_passkeys where user_id = ${userId}`;
    await tx`delete from auth_sessions where user_id = ${userId}`;
    // Die Tabelle entsteht erst, wenn HAPM einmal gestartet ist. Ein Fehler
    // mitten in der Transaktion bräche sie ab, deshalb vorher nachsehen.
    const [{ present }] = await tx`select to_regclass('two_factor') is not null as present`;
    if (present) await tx`delete from two_factor where data->>'userId' = ${userId}`;
  });

  console.log(`Neues Passwort für ${wanted}:`);
  console.log('');
  console.log(`  ${password}`);
  console.log('');
  console.log('Der zweite Faktor ist abgeschaltet, die Passkeys des Kontos sind entfernt,');
  console.log('alle seine Sitzungen sind beendet.');
  console.log('Bitte nach der Anmeldung unter „Konto" ein eigenes Passwort setzen.');
  if (await isReplica(db)) {
    console.log('');
    console.log('Achtung: dieser Knoten ist ein Folgeknoten, seine Konten kommen vom Hauptknoten.');
    console.log('Das neue Passwort gilt nur, bis der Hauptknoten seinen Stand erneut überträgt');
    console.log('(spätestens nach einer Stunde). Läuft der Hauptknoten noch: dort zurücksetzen.');
    console.log('Ist er ausgefallen: anmelden und unter „Abgleich" die Rolle umstellen.');
  }
  return 0;
}

/**
 * Ob dieser Knoten ein Folgeknoten ist (docs/hochverfuegbarkeit.md). Die Zeile
 * gibt es erst, wenn HAPM einmal gestartet ist. Ohne sie und bei jedem Fehler:
 * nein, der Hinweis ist eine Hilfe und keine Bedingung.
 *
 * @param {ReturnType<typeof postgres>} db
 */
async function isReplica(db) {
  try {
    const [{ present }] = await db`select to_regclass('sync_settings') is not null as present`;
    if (!present) return false;
    const rows = await db`select data->>'role' as role from sync_settings where id = 'main'`;
    return rows[0]?.role === 'replica';
  } catch {
    return false;
  }
}

const [command, argument] = process.argv.slice(2);
let code = 2;
const db = connect();
try {
  if (command === 'users') code = await users(db);
  else if (command === 'reset-password') code = await resetPassword(db, argument);
  else console.error('Aufruf: hapm-admin users | reset-password <e-mail>');
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    /** @type {{ code?: string }} */ (err)?.code === 'ENOENT' || /ECONNREFUSED|ENOENT/.test(message)
      ? `Postgres ist nicht erreichbar: ${message}`
      : message
  );
  code = 1;
} finally {
  await db.end({ timeout: 5 }).catch(() => {});
}
process.exit(code);
