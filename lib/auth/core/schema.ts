/**
 * Die Tabellen, die Better-Auth erwartet — als Drizzle-Schema.
 *
 * Ihre Form gibt die Bibliothek vor, nicht HAPM. Deshalb liegen sie hier beim
 * Anmeldedienst und nicht bei den Daten von HAPM (`lib/db`): ändert ein
 * Better-Auth-Update eine Tabelle, ist das die eine Stelle, die mitzieht.
 * Angelegt werden sie durch `lib/db/auth-tables.ts`.
 *
 * ── Die Tabellen heißen `auth_*`, nicht `user`/`session`/`account` ──
 *
 * Better-Auths Vorgabe ist `user`, und `USER` ist ein reserviertes Wort in
 * SQL: `select * from user` gibt in Postgres den aktuellen Rollennamen zurück
 * statt einer Fehlermeldung — die stillste Art, eine Abfrage falsch zu
 * beantworten. `session` und `account` sind nicht reserviert, werden hier aber
 * mitgezogen, weil ein Präfix die Tabellen der Anmeldung in `\dt` beieinander
 * hält, statt sie zwischen die Tabellen von HAPM zu mischen.
 *
 * Das kostet nichts: der `drizzleAdapter` bekommt die Tabellenobjekte über
 * `authSchemaMap()` und nimmt den physischen Namen von dort. Die Modellnamen
 * der Bibliothek (`user`, `session`, …) bleiben unverändert.
 *
 * ── Alle Zeitstempel sind `timestamptz` ──
 *
 * Better-Auths eigene Vorlage nimmt `timestamp` ohne Zeitzone. Eine Sitzung
 * läuft aber zu einem Zeitpunkt ab, nicht zu einer Uhrzeit: steht der Prozess
 * auf UTC und die Datenbank auf `Europe/Berlin`, verschiebt sich jedes
 * `expires_at` um eine oder zwei Stunden — und zur Zeitumstellung wird eine
 * Stunde doppelt oder gar nicht vergeben. Ein Anmeldetoken, das eine Stunde
 * länger gilt als gedacht, fällt niemandem auf.
 *
 * ── Warum Spaltenbündel und fertige Tabellen ──
 *
 * Braucht der Benutzer einmal eine eigene Spalte (eine Rolle etwa), lässt sie
 * sich nicht nachträglich anhängen: Drizzle kann eine `pgTable` nicht
 * erweitern. Dieses Modul exportiert deshalb beides:
 *
 *   authUsers                     die fertige Tabelle, wenn nichts fehlt
 *   authUserColumns               die Spalten zum Hineinspreizen
 *
 * ```ts
 * export const users = pgTable('auth_users', {
 *   ...authUserColumns,
 *   platformRole: platformRoleEnum('platform_role').notNull().default('none'),
 * });
 *
 * // und dann beim Adapter:
 * drizzleAdapter(db, { provider: 'pg', schema: authSchemaMap({ user: users }) })
 * ```
 *
 * Eine eigene Spalte muss eine Voreinstellung haben oder nullable sein — die
 * Inserts der Bibliothek kennen sie nicht.
 */

import { boolean, index, integer, pgSchema, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

const stamp = (name: string) => timestamp(name, { withTimezone: true });

export const authUserColumns = {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: stamp('created_at').notNull().defaultNow(),
  updatedAt: stamp('updated_at').notNull().defaultNow(),
};

/**
 * Die Tabellen, in einem wählbaren Schema.
 *
 * ── Warum das eine Fabrik ist und keine Konstanten ──
 *
 * "public" ist das Schema, das eine PostgREST-Daten-API exponiert. Konten und
 * Passwort-Hashes gehören dort nicht hin: RLS hielte die ZEILEN zurück, aber
 * Tabellen- und Spaltennamen stünden trotzdem im Schema-Cache und in der
 * OpenAPI-Ausgabe. Wer eine solche API vor dieselbe Datenbank stellt, legt die
 * Tabellen der Anmeldung deshalb in ein eigenes Schema.
 *
 * Ohne Argument liegen die Tabellen in dem Schema, das der Suchpfad vorgibt,
 * also üblicherweise "public". So benutzt HAPM sie, und das ist Absicht: eine
 * bestehende Datenbank soll sich durch ein Update nicht verschieben. Ein
 * Update, das die Tabellenauflösung ändert, ist genau die Art Überraschung,
 * die eine Anmeldung stilllegt.
 *
 * Wer umzieht, sagt es hier UND schiebt die Tabellen mit
 * ALTER TABLE … SET SCHEMA hinüber — beides im selben Deploy. Sonst sucht der
 * Anmeldedienst an einer Stelle, an der nichts steht, und niemand kommt mehr
 * hinein.
 */
export function createAuthTables(schemaName?: string) {
  // pgSchema(name).table und pgTable nehmen dieselben Argumente, tragen den
  // Schemanamen aber im Typ (`PgTableFn<string>` gegen `PgTableFn<undefined>`).
  // Die Vereinigung ist damit nicht aufrufbar — der Cast holt die eine
  // Signatur zurück, die beide erfüllen. Zur Laufzeit trägt das erzeugte
  // Tabellenobjekt sein Schema selbst, und nur das entscheidet, welches SQL
  // Drizzle daraus baut.
  const table = (schemaName ? pgSchema(schemaName).table : pgTable) as typeof pgTable;

  const authUsers = table('auth_users', authUserColumns);

  const authSessions = table(
    'auth_sessions',
    {
      id: text('id').primaryKey(),
      expiresAt: stamp('expires_at').notNull(),
      token: text('token').notNull().unique(),
      createdAt: stamp('created_at').notNull().defaultNow(),
      updatedAt: stamp('updated_at').notNull().defaultNow(),
      ipAddress: text('ip_address'),
      userAgent: text('user_agent'),
      // `cascade`: eine Sitzung ohne Konto ist kein Zustand, sondern ein offener
      // Zugang zu etwas, das es nicht mehr gibt.
      userId: text('user_id')
        .notNull()
        .references(() => authUsers.id, { onDelete: 'cascade' }),
    },
    (t) => [
      /** „Alle Geräte abmelden" und die Anzeige der aktiven Sitzungen. */
      index('auth_sessions_user_idx').on(t.userId),
      /** Der Aufräumlauf für abgelaufene Sitzungen. */
      index('auth_sessions_expires_idx').on(t.expiresAt),
    ]
  );

  const authAccounts = table(
    'auth_accounts',
    {
      id: text('id').primaryKey(),
      accountId: text('account_id').notNull(),
      providerId: text('provider_id').notNull(),
      userId: text('user_id')
        .notNull()
        .references(() => authUsers.id, { onDelete: 'cascade' }),
      accessToken: text('access_token'),
      refreshToken: text('refresh_token'),
      idToken: text('id_token'),
      accessTokenExpiresAt: stamp('access_token_expires_at'),
      refreshTokenExpiresAt: stamp('refresh_token_expires_at'),
      scope: text('scope'),
      /** Nur bei E-Mail und Passwort belegt; enthält den Hash, nie das Passwort. */
      password: text('password'),
      createdAt: stamp('created_at').notNull().defaultNow(),
      updatedAt: stamp('updated_at').notNull().defaultNow(),
    },
    (t) => [
      index('auth_accounts_user_idx').on(t.userId),
      /**
       * Der Weg jeder Anmeldung: Anbieter plus dessen Konto-ID.
       *
       * Eindeutig und nicht nur indiziert — dasselbe Google-Konto zweimal
       * verknüpft hieße zwei Zeilen, von denen die Bibliothek eine nimmt, und
       * welche, entscheidet die Reihenfolge auf der Platte.
       */
      uniqueIndex('auth_accounts_provider_key').on(t.providerId, t.accountId),
    ]
  );

  const authVerifications = table(
    'auth_verifications',
    {
      id: text('id').primaryKey(),
      identifier: text('identifier').notNull(),
      value: text('value').notNull(),
      expiresAt: stamp('expires_at').notNull(),
      createdAt: stamp('created_at').notNull().defaultNow(),
      updatedAt: stamp('updated_at').notNull().defaultNow(),
    },
    (t) => [
      /**
       * Jede Passwortzurücksetzung und jede Mail-Bestätigung sucht hierüber.
       * Ohne Index ist das ein Seq-Scan über eine Tabelle, die nur wächst, weil
       * benutzte Einträge nicht sofort verschwinden.
       */
      index('auth_verifications_identifier_idx').on(t.identifier),
      index('auth_verifications_expires_idx').on(t.expiresAt),
    ]
  );

  /**
   * Der zweite Faktor. Nur nötig, wenn `twoFactor: true` gesetzt wird.
   *
   * Eigene Tabelle statt Spalten am Benutzer, weil Better-Auth es so erwartet —
   * und weil ein Konto ohne zweiten Faktor dann keine leeren Spalten trägt.
   */
  const authTwoFactors = table(
    'auth_two_factors',
    {
      id: text('id').primaryKey(),
      /** TOTP-Geheimnis. Gehört verschlüsselt in die Datenbank, siehe README. */
      secret: text('secret').notNull(),
      backupCodes: text('backup_codes').notNull(),
      userId: text('user_id')
        .notNull()
        .references(() => authUsers.id, { onDelete: 'cascade' }),
    },
    (t) => [index('auth_two_factors_user_idx').on(t.userId)]
  );


  /**
   * Passkeys (WebAuthn). Nur nötig, wenn `passkey` gesetzt wird.
   *
   * Die Spalten gibt das Plugin `@better-auth/passkey` vor. Die Eigenschaften
   * heißen deshalb wie dort (`credentialID`, nicht `credentialId`): der Adapter
   * ordnet über den Namen der Eigenschaft zu, nicht über den der Spalte.
   *
   * Hier liegt kein Geheimnis. `public_key` ist der öffentliche Teil, der
   * private verlässt das Gerät des Benutzers nie. Die Zeile muss deshalb nicht
   * verschlüsselt werden, und ein Abzug der Tabelle öffnet kein Konto.
   */
  const authPasskeys = table(
    'auth_passkeys',
    {
      id: text('id').primaryKey(),
      /** Vom Benutzer vergebener Name, z. B. „MacBook" oder „iPhone". */
      name: text('name'),
      publicKey: text('public_key').notNull(),
      userId: text('user_id')
        .notNull()
        .references(() => authUsers.id, { onDelete: 'cascade' }),
      credentialID: text('credential_id').notNull(),
      /** Zähler der Signaturen. Geht er zurück, wurde der Schlüssel kopiert. */
      counter: integer('counter').notNull(),
      /** `singleDevice` oder `multiDevice` (mit der Cloud des Herstellers abgeglichen). */
      deviceType: text('device_type').notNull(),
      backedUp: boolean('backed_up').notNull(),
      transports: text('transports'),
      createdAt: stamp('created_at').defaultNow(),
      /** Kennung des Gerätemodells, für eine lesbare Bezeichnung in der Liste. */
      aaguid: text('aaguid'),
    },
    (t) => [
      index('auth_passkeys_user_idx').on(t.userId),
      /**
       * Eindeutig: die Anmeldung findet den Benutzer allein über diese Kennung.
       * Zwei Zeilen mit derselben hießen, dass die Reihenfolge auf der Platte
       * entscheidet, wer angemeldet wird.
       */
      uniqueIndex('auth_passkeys_credential_key').on(t.credentialID),
    ]
  );

  return { authUsers, authSessions, authAccounts, authVerifications, authTwoFactors, authPasskeys };
}

/**
 * Die Tabellen im Vorgabeschema.
 *
 * Das sind die Tabellen, mit denen HAPM arbeitet: `createAuth` nimmt sie,
 * wenn unter `tables` nichts anderes steht.
 */
export const { authUsers, authSessions, authAccounts, authVerifications, authTwoFactors, authPasskeys } =
  createAuthTables();

/** Was `drizzleAdapter` als `schema` erwartet: Modellname → Tabelle. */
export function authSchemaMap(tables?: {
  user?: unknown;
  session?: unknown;
  account?: unknown;
  verification?: unknown;
  twoFactor?: unknown;
  passkey?: unknown;
}) {
  return {
    user: tables?.user ?? authUsers,
    session: tables?.session ?? authSessions,
    account: tables?.account ?? authAccounts,
    verification: tables?.verification ?? authVerifications,
    ...(tables?.twoFactor ? { twoFactor: tables.twoFactor } : { twoFactor: authTwoFactors }),
    passkey: tables?.passkey ?? authPasskeys,
  };
}

/**
 * Die Tabellen eines Schemas, gleich in der Form, die `createAuth`
 * unter `tables` erwartet.
 *
 * Ohne das müsste jeder Aufrufer die fünf Namen von Hand umbenennen
 * (`authUsers` → `user`), und das ist die Sorte Abschrift, bei der irgendwann
 * eine Zeile fehlt — ausgerechnet `twoFactor`, das man erst bemerkt, wenn
 * jemand seinen zweiten Faktor einrichten will.
 */
export function authTablesIn(schemaName?: string) {
  const t = createAuthTables(schemaName);
  return {
    user: t.authUsers,
    session: t.authSessions,
    account: t.authAccounts,
    verification: t.authVerifications,
    twoFactor: t.authTwoFactors,
    passkey: t.authPasskeys,
  };
}
