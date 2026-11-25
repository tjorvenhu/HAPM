/**
 * Die Tabellen der Anmeldung (Better-Auth über `lib/auth/core`).
 *
 * Ihre Form steht in `lib/auth/core/schema.ts` (Drizzle) und folgt dem, was
 * Better-Auth erwartet. Gelesen und geschrieben werden sie nur durch den
 * Anmeldedienst, HAPM legt sie beim Start an.
 *
 * ── Warum das SQL ausgeschrieben dasteht und nicht aus Drizzle entsteht ──
 *
 * Was hier steht, ist der Stand, den die Datenbanken im Betrieb haben.
 * `create table if not exists` fasst eine vorhandene Tabelle nicht an: bringt
 * eine neue Fassung des Kerns eine Spalte mit, legte erzeugtes SQL sie auf
 * einer frischen Installation an und auf jeder bestehenden nicht, und auffallen
 * würde es bei der ersten Anmeldung dort.
 *
 * `tests/auth/auth-tables.test.ts` vergleicht diese Anweisungen deshalb mit den
 * Definitionen des Kerns und schlägt an, sobald beide auseinanderlaufen. Dann
 * gehört die Änderung an zwei Stellen: in die Anweisung der Tabelle (für neue
 * Installationen) und als `alter table … add column if not exists …` ans Ende
 * von `AUTH_TABLE_STATEMENTS` (für bestehende).
 *
 * `auth_two_factors` gehört zu den Tabellen des Kerns, HAPM benutzt sie nicht: der zweite
 * Faktor steht in `two_factor` (`lib/two-factor.ts`).
 */

import { sql, type Sql } from './postgres-driver';

export const AUTH_TABLE_STATEMENTS: string[] = [
  'create table if not exists "auth_users" (' +
    '"id" text primary key, ' +
    '"name" text not null, ' +
    '"email" text not null, ' +
    '"email_verified" boolean not null default false, ' +
    '"image" text, ' +
    '"created_at" timestamp with time zone not null default now(), ' +
    '"updated_at" timestamp with time zone not null default now(), ' +
    'constraint "auth_users_email_unique" unique ("email"))',

  'create table if not exists "auth_sessions" (' +
    '"id" text primary key, ' +
    '"expires_at" timestamp with time zone not null, ' +
    '"token" text not null, ' +
    '"created_at" timestamp with time zone not null default now(), ' +
    '"updated_at" timestamp with time zone not null default now(), ' +
    '"ip_address" text, ' +
    '"user_agent" text, ' +
    '"user_id" text not null references "auth_users" ("id") on delete cascade, ' +
    'constraint "auth_sessions_token_unique" unique ("token"))',
  'create index if not exists "auth_sessions_user_idx" on "auth_sessions" ("user_id")',
  'create index if not exists "auth_sessions_expires_idx" on "auth_sessions" ("expires_at")',

  'create table if not exists "auth_accounts" (' +
    '"id" text primary key, ' +
    '"account_id" text not null, ' +
    '"provider_id" text not null, ' +
    '"user_id" text not null references "auth_users" ("id") on delete cascade, ' +
    '"access_token" text, ' +
    '"refresh_token" text, ' +
    '"id_token" text, ' +
    '"access_token_expires_at" timestamp with time zone, ' +
    '"refresh_token_expires_at" timestamp with time zone, ' +
    '"scope" text, ' +
    '"password" text, ' +
    '"created_at" timestamp with time zone not null default now(), ' +
    '"updated_at" timestamp with time zone not null default now())',
  'create index if not exists "auth_accounts_user_idx" on "auth_accounts" ("user_id")',
  'create unique index if not exists "auth_accounts_provider_key" on "auth_accounts" ("provider_id", "account_id")',

  'create table if not exists "auth_verifications" (' +
    '"id" text primary key, ' +
    '"identifier" text not null, ' +
    '"value" text not null, ' +
    '"expires_at" timestamp with time zone not null, ' +
    '"created_at" timestamp with time zone not null default now(), ' +
    '"updated_at" timestamp with time zone not null default now())',
  'create index if not exists "auth_verifications_identifier_idx" on "auth_verifications" ("identifier")',
  'create index if not exists "auth_verifications_expires_idx" on "auth_verifications" ("expires_at")',

  'create table if not exists "auth_two_factors" (' +
    '"id" text primary key, ' +
    '"secret" text not null, ' +
    '"backup_codes" text not null, ' +
    '"user_id" text not null references "auth_users" ("id") on delete cascade)',
  'create index if not exists "auth_two_factors_user_idx" on "auth_two_factors" ("user_id")',

  'create table if not exists "auth_passkeys" (' +
    '"id" text primary key, ' +
    '"name" text, ' +
    '"public_key" text not null, ' +
    '"user_id" text not null references "auth_users" ("id") on delete cascade, ' +
    '"credential_id" text not null, ' +
    '"counter" integer not null, ' +
    '"device_type" text not null, ' +
    '"backed_up" boolean not null, ' +
    '"transports" text, ' +
    '"created_at" timestamp with time zone default now(), ' +
    '"aaguid" text)',
  'create index if not exists "auth_passkeys_user_idx" on "auth_passkeys" ("user_id")',
  'create unique index if not exists "auth_passkeys_credential_key" on "auth_passkeys" ("credential_id")',
];

export async function ensureAuthTables(db: Sql = sql()): Promise<void> {
  for (const statement of AUTH_TABLE_STATEMENTS) await db.unsafe(statement);
}

/**
 * Abgelaufene Sitzungen und Einmalwerte entfernen. Als SQL und nicht über die
 * Fassade: die Tabellen gehören dem Anmeldedienst und sind keine Collections.
 */
export async function pruneAuthTables(db: Sql = sql()): Promise<number> {
  const sessions = await db`delete from auth_sessions where expires_at < now()`;
  const verifications = await db`delete from auth_verifications where expires_at < now()`;
  return sessions.count + verifications.count;
}

/**
 * Wie viele Passkeys an welchem Konto hängen. Konten ohne Passkey fehlen.
 *
 * Als SQL und nicht über den Adapter des Anmeldedienstes: der kennt die Tabelle
 * nur, solange die Adresse von HAPM eingerichtet ist. Die Zeilen gibt es auch
 * danach noch, und die Benutzerliste soll sie zählen.
 */
export async function countPasskeysByUser(db: Sql = sql()): Promise<Map<string, number>> {
  const rows = await db<{ user_id: string; count: number }[]>`
    select user_id, count(*)::int as count from auth_passkeys group by user_id
  `;
  return new Map(rows.map((row) => [row.user_id, row.count]));
}

/**
 * Alle Passkeys löschen. Ein Passkey ist an die Domain gebunden, unter der er
 * entstand; nach einem Wechsel der Adresse von HAPM meldet er niemanden mehr an
 * und stünde nur noch als Eintrag ohne Wirkung unter „Konto". Gerufen von
 * `updateSettings`, sobald sich der Host der Adresse ändert.
 */
export async function deleteAllPasskeys(db: Sql = sql()): Promise<number> {
  const result = await db`delete from auth_passkeys`;
  return result.count;
}

