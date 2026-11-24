/**
 * Was hier geprüft wird, ist Absicht und keine Abschrift der Bibliothek.
 *
 * Better-Auths Vorlage heißt `user`, und beim nächsten Update oder beim
 * nächsten Blick in deren Dokumentation ist die naheliegende Änderung, sich
 * daran anzugleichen. Diese Datei sagt, warum das nicht passieren darf.
 */

import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  createAuthTables,
  authTablesIn,
  authAccounts,
  authPasskeys,
  authSchemaMap,
  authSessions,
  authTwoFactors,
  authUsers,
  authVerifications,
} from '@/lib/auth/core/schema';

const TABLES = [
  authUsers,
  authSessions,
  authAccounts,
  authVerifications,
  authTwoFactors,
  authPasskeys,
] as const;

/** Reservierte Wörter, die als Tabellenname besonders naheliegen. */
const RESERVED = new Set([
  'user',
  'session',
  'authorization',
  'grant',
  'order',
  'group',
  'table',
  'column',
  'references',
  'check',
  'default',
  'limit',
  'offset',
  'end',
]);

describe('Tabellennamen', () => {
  it('benutzt kein reserviertes SQL-Wort', () => {
    for (const table of TABLES) {
      const name = getTableConfig(table).name;
      expect(RESERVED.has(name.toLowerCase()), `${name} ist reserviert`).toBe(false);
    }
  });

  it('trägt durchgehend das auth_-Präfix', () => {
    const names = TABLES.map((t) => getTableConfig(t).name);
    expect(names).toEqual([
      'auth_users',
      'auth_sessions',
      'auth_accounts',
      'auth_verifications',
      'auth_two_factors',
      'auth_passkeys',
    ]);
  });
});

describe('Zeitstempel', () => {
  /**
   * Eine Sitzung läuft zu einem Zeitpunkt ab, nicht zu einer Uhrzeit. Ohne
   * Zeitzone verschiebt ein Prozess auf UTC gegen eine Datenbank auf
   * Europe/Berlin jedes `expires_at` um eine Stunde — nach oben, also gilt das
   * Token länger als gedacht.
   */
  it('sind überall timestamptz', () => {
    for (const table of TABLES) {
      const { name, columns } = getTableConfig(table);
      for (const column of columns) {
        if (!column.getSQLType().startsWith('timestamp')) continue;
        expect(
          column.getSQLType(),
          `${name}.${column.name} hat keine Zeitzone`
        ).toContain('with time zone');
      }
    }
  });
});

describe('Indizes', () => {
  /**
   * Jede Passwortzurücksetzung sucht über `identifier`. Ohne Index ist das ein
   * Seq-Scan über eine Tabelle, die nur wächst.
   */
  it('deckt die Nachschlagespalten ab', () => {
    const indexed = (table: (typeof TABLES)[number]) =>
      new Set(
        getTableConfig(table).indexes.flatMap((i) =>
          i.config.columns.map((c) => ('name' in c ? c.name : ''))
        )
      );

    expect(indexed(authSessions)).toContain('user_id');
    expect(indexed(authSessions)).toContain('expires_at');
    expect(indexed(authAccounts)).toContain('user_id');
    expect(indexed(authVerifications)).toContain('identifier');
    expect(indexed(authTwoFactors)).toContain('user_id');
  });

  it('macht Anbieter plus Konto-ID eindeutig', () => {
    const unique = getTableConfig(authAccounts).indexes.find((i) => i.config.unique);
    expect(unique?.config.columns.map((c) => ('name' in c ? c.name : ''))).toEqual([
      'provider_id',
      'account_id',
    ]);
  });
});

describe('authSchemaMap', () => {
  /**
   * Die Modellnamen der Bibliothek bleiben `user`/`session`/…, nur die
   * physischen Tabellen heißen anders. Genau deshalb kostet die Umbenennung
   * nichts.
   */
  it('behält die Modellnamen von Better-Auth', () => {
    expect(Object.keys(authSchemaMap()).sort()).toEqual([
      'account',
      'passkey',
      'session',
      'twoFactor',
      'user',
      'verification',
    ]);
  });

  it('lässt eine erweiterte Benutzertabelle durch', () => {
    const custom = {};
    expect(authSchemaMap({ user: custom }).user).toBe(custom);
    expect(authSchemaMap({ user: custom }).session).toBe(authSessions);
  });
});

describe('createAuthTables — das Schema', () => {
  it('legt ohne Angabe kein Schema fest', () => {
    // Ein Update darf die Tabellenauflösung einer bestehenden Datenbank
    // nicht verschieben. Ohne Argument bleibt es beim Suchpfad.
    const sql = getTableConfig(createAuthTables().authUsers);
    expect(sql.schema).toBeUndefined();
  });

  it('setzt das angegebene Schema auf ALLE Tabellen', () => {
    // Vier von fünf reichen nicht: eine Sitzung in `public` und ein Konto in
    // `auth` heißt, dass die Anmeldung durchkommt und beim zweiten Faktor
    // scheitert — der Fehler, der wie ein kaputtes TOTP aussieht.
    const t = createAuthTables('auth');
    for (const table of Object.values(t)) {
      expect(getTableConfig(table).schema).toBe('auth');
    }
  });

  it('liefert über authTablesIn genau die Schlüssel, die der Adapter erwartet', () => {
    // Die Umbenennung authUsers → user ist die Abschrift, bei der irgendwann
    // `twoFactor` fehlt — und das bemerkt man erst, wenn jemand seinen
    // zweiten Faktor einrichtet.
    expect(Object.keys(authTablesIn('auth')).sort()).toEqual([
      'account',
      'passkey',
      'session',
      'twoFactor',
      'user',
      'verification',
    ]);
  });
});

describe('Passkeys', () => {
  /**
   * Der Adapter ordnet über den Namen der Eigenschaft zu. Das Plugin schreibt
   * `credentialID` mit zwei Großbuchstaben am Ende. Wer das beim Aufräumen zu
   * `credentialId` glättet, bekommt beim ersten Hinterlegen einen Fehler aus
   * der Datenbank und nicht aus dem Compiler.
   */
  it('benennt die Eigenschaften wie das Plugin', () => {
    expect(Object.keys(authPasskeys)).toEqual(
      expect.arrayContaining([
        'id', 'name', 'publicKey', 'userId', 'credentialID', 'counter',
        'deviceType', 'backedUp', 'transports', 'createdAt', 'aaguid',
      ])
    );
  });

  /**
   * Die Anmeldung findet den Benutzer allein über die Kennung des Passkeys.
   * Ohne Eindeutigkeit entschiede die Reihenfolge auf der Platte, wer
   * angemeldet wird.
   */
  it('macht die Kennung eindeutig', () => {
    const unique = getTableConfig(authPasskeys).indexes.filter((i) => i.config.unique);
    expect(unique.map((i) => i.config.name)).toEqual(['auth_passkeys_credential_key']);
  });

  it('löscht die Passkeys mit dem Konto', () => {
    const [fk] = getTableConfig(authPasskeys).foreignKeys;
    expect(fk?.onDelete).toBe('cascade');
  });

  it('nimmt eine eigene Tabelle an und fällt sonst auf die mitgelieferte zurück', () => {
    const custom = {};
    expect(authSchemaMap({ passkey: custom }).passkey).toBe(custom);
    expect(authSchemaMap().passkey).toBe(authPasskeys);
  });
});
