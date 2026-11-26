/**
 * Die Konten als Zeilen lesen und durch die eines anderen Knotens ersetzen,
 * für den Abgleich (`lib/sync/data-collect.ts`, `data-apply.ts`).
 *
 * Als SQL und nicht über den Anmeldedienst: der legt ein Konto an, ändert ein
 * Passwort oder löscht ein Konto, kennt aber kein „diese Tabelle soll danach
 * so aussehen". Und der Tausch muss in einer Transaktion stehen. Bräche er
 * zwischen Löschen und Anlegen ab, stünde ein Knoten ohne Konto da.
 *
 * Nicht dabei: `auth_sessions` und `auth_verifications`. Wer wo angemeldet ist
 * und welcher Link zum Zurücksetzen offen ist, gehört dem Knoten.
 */

import type { SyncAccount, SyncPasskey, SyncUser } from '../sync/data';
import { sql, type Sql } from './postgres-driver';

export interface AccountRows {
  users: SyncUser[];
  accounts: SyncAccount[];
  passkeys: SyncPasskey[];
}

/**
 * Die Zeitstempel als fertiger ISO-Text aus der Datenbank, wie in `sql.ts`:
 * die Verbindung teilt sich der Treiber mit Drizzle, und das stellt an ihr um,
 * wie `timestamptz` gelesen wird.
 */
function isoColumn(db: Sql, column: string) {
  return db.unsafe(`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ${column}`);
}

function iso(value: unknown): string {
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

export async function readAccountRows(db: Sql = sql()): Promise<AccountRows> {
  const [users, accounts, passkeys] = await Promise.all([
    db`select id, name, email, email_verified, image, ${isoColumn(db, 'created_at')} from auth_users order by id`,
    // Nur der Zugang mit Passwort: einen anderen legt HAPM nicht an.
    db`select id, account_id, provider_id, user_id, password, ${isoColumn(db, 'created_at')} from auth_accounts where provider_id = 'credential' order by id`,
    db`select id, name, public_key, user_id, credential_id, counter, device_type, backed_up, transports, ${isoColumn(db, 'created_at')}, aaguid from auth_passkeys order by id`,
  ]);
  return {
    users: users.map((row) => ({
      id: String(row.id),
      name: String(row.name ?? ''),
      email: String(row.email),
      emailVerified: row.email_verified === true,
      image: row.image === null ? null : String(row.image),
      createdAt: iso(row.created_at),
    })),
    accounts: accounts.map((row) => ({
      id: String(row.id),
      accountId: String(row.account_id),
      providerId: String(row.provider_id),
      userId: String(row.user_id),
      password: row.password === null ? null : String(row.password),
      createdAt: iso(row.created_at),
    })),
    passkeys: passkeys.map((row) => ({
      id: String(row.id),
      name: row.name === null ? null : String(row.name),
      publicKey: String(row.public_key),
      userId: String(row.user_id),
      credentialId: String(row.credential_id),
      counter: Number(row.counter) || 0,
      deviceType: String(row.device_type),
      backedUp: row.backed_up === true,
      transports: row.transports === null ? null : String(row.transports),
      createdAt: row.created_at === null ? null : iso(row.created_at),
      aaguid: row.aaguid === null ? null : String(row.aaguid),
    })),
  };
}

export interface AccountChange {
  /** Kennungen der Konten, die es vorher nicht gab. */
  added: string[];
  /** Kennungen der Konten, die es nicht mehr gibt. Ihre Sitzungen sind mit ihnen weg. */
  removed: string[];
  /** Konten, deren Passwort sich geändert hat. Ihre Sitzungen hier wurden beendet. */
  passwordChanged: string[];
}

/**
 * Die Konten dieses Knotens durch `rows` ersetzen, in einer Transaktion.
 *
 * Ein Konto mit derselben Kennung bleibt dieselbe Zeile, und seine Sitzungen
 * bleiben: sonst meldete jeder Abgleich alle ab. Zwei Ausnahmen. Ein Konto,
 * das der Hauptknoten nicht nennt, verschwindet samt Sitzungen (das Fremd-
 * schlüssel-`cascade` der Tabellen). Und hat sich ein Passwort geändert, enden
 * die Sitzungen dieses Kontos hier: wer sein Passwort ändert, will andere
 * Geräte abmelden, auf jedem Knoten.
 *
 * Der Zähler eines Passkeys geht nie zurück: es gilt der größere von beiden.
 */
export async function replaceAccountRows(rows: AccountRows, db: Sql = sql()): Promise<AccountChange> {
  if (rows.users.length === 0) throw new Error('Ohne Konto wird nichts ersetzt.');
  const userIds = rows.users.map((user) => user.id);
  const accountIds = rows.accounts.map((account) => account.id);
  const passkeyIds = rows.passkeys.map((passkey) => passkey.id);

  return db.begin(async (tx) => {
    const before = await tx`select id from auth_users`;
    const known = new Set(before.map((row) => String(row.id)));
    const wanted = new Set(userIds);
    const change: AccountChange = {
      added: userIds.filter((id) => !known.has(id)),
      removed: [...known].filter((id) => !wanted.has(id)),
      passwordChanged: [],
    };

    // Zuerst weg, was nicht bleibt: eine E-Mail-Adresse ist eindeutig, und ein
    // Konto des Hauptknotens darf an einer gleichnamigen Zeile hier nicht scheitern.
    await tx`delete from auth_users where not (id = any(${userIds}))`;
    for (const user of rows.users) {
      await tx`
        insert into auth_users (id, name, email, email_verified, image, created_at, updated_at)
        values (${user.id}, ${user.name}, ${user.email}, ${user.emailVerified}, ${user.image}, ${user.createdAt}, now())
        on conflict (id) do update set
          name = excluded.name,
          email = excluded.email,
          email_verified = excluded.email_verified,
          image = excluded.image,
          updated_at = now()
        where (auth_users.name, auth_users.email, auth_users.email_verified, auth_users.image)
          is distinct from (excluded.name, excluded.email, excluded.email_verified, excluded.image)
      `;
    }

    const passwords = await tx`select id, user_id, password from auth_accounts where provider_id = 'credential'`;
    const oldPassword = new Map(passwords.map((row) => [String(row.id), row.password === null ? null : String(row.password)]));
    await tx`delete from auth_accounts where not (id = any(${accountIds}))`;
    for (const account of rows.accounts) {
      await tx`
        insert into auth_accounts (id, account_id, provider_id, user_id, password, created_at, updated_at)
        values (${account.id}, ${account.accountId}, ${account.providerId}, ${account.userId}, ${account.password}, ${account.createdAt}, now())
        on conflict (id) do update set
          account_id = excluded.account_id,
          provider_id = excluded.provider_id,
          user_id = excluded.user_id,
          password = excluded.password,
          updated_at = now()
        where (auth_accounts.account_id, auth_accounts.provider_id, auth_accounts.user_id, auth_accounts.password)
          is distinct from (excluded.account_id, excluded.provider_id, excluded.user_id, excluded.password)
      `;
      if (known.has(account.userId) && oldPassword.has(account.id) && oldPassword.get(account.id) !== account.password) {
        change.passwordChanged.push(account.userId);
      }
    }
    if (change.passwordChanged.length > 0) {
      await tx`delete from auth_sessions where user_id = any(${change.passwordChanged})`;
    }

    await tx`delete from auth_passkeys where not (id = any(${passkeyIds}))`;
    for (const passkey of rows.passkeys) {
      await tx`
        insert into auth_passkeys (id, name, public_key, user_id, credential_id, counter, device_type, backed_up, transports, created_at, aaguid)
        values (${passkey.id}, ${passkey.name}, ${passkey.publicKey}, ${passkey.userId}, ${passkey.credentialId}, ${passkey.counter},
          ${passkey.deviceType}, ${passkey.backedUp}, ${passkey.transports}, ${passkey.createdAt}, ${passkey.aaguid})
        on conflict (id) do update set
          name = excluded.name,
          public_key = excluded.public_key,
          user_id = excluded.user_id,
          credential_id = excluded.credential_id,
          counter = greatest(auth_passkeys.counter, excluded.counter),
          device_type = excluded.device_type,
          backed_up = excluded.backed_up,
          transports = excluded.transports,
          aaguid = excluded.aaguid
      `;
    }
    return change;
  }) as Promise<AccountChange>;
}
