/**
 * Konten. Ein Konto entsteht, ändert sich und vergeht nur über diese Datei.
 *
 * Wer sich anmelden kann, darf alles: es gibt keine Rollen. HAPM verwaltet eine
 * Maschine, und wer ihre Konfiguration schreiben darf, hat sie ohnehin ganz.
 *
 * ── Warum nicht über `auth().api.*` ──
 *
 * `signUpEmail` legt nebenbei eine Sitzung an (wer ein Konto für jemanden
 * anlegt, wird nicht zu ihm), und `changePassword` stellt beim Beenden
 * der anderen Sitzungen eine neue aus, an der der Nachweis des zweiten Faktors
 * dann nicht mehr hängt. Der `internalAdapter` ist die Ebene darunter: dieselben
 * Schreibvorgänge, ohne den Sitzungsteil.
 *
 * Gehasht und geprüft wird trotzdem nicht hier, sondern über `ctx.password`.
 * Ein eigener Hash wäre die zweite Quelle für dasselbe Format.
 *
 * ── Was daneben liegt ──
 *
 * Konto und Passwort stehen in `auth_users` und `auth_accounts`. Der zweite
 * Faktor (`two_factor`), die letzte Anmeldung und die Sprache (`user_state`) sind Zeilen von
 * HAPM, gekoppelt über die Kennung des Kontos. Wer ein Konto löscht, nimmt sie
 * hier mit.
 */

import { createDocument, deleteDocument, getDocument, listAll, updateDocument, NotFoundError } from '../db';
import { countPasskeysByUser } from '../db/auth-tables';
import { ApiError } from '../api';
import { isLocale, msg, type Locale } from '../i18n';
import { remove2FA } from '../two-factor';
import { validateEmail, validatePassword } from '../validation';
import { COLLECTIONS, type TwoFactorConfig, type UserState } from '../types';
import { auth } from './config';

/** Better-Auths Name für die Anmeldung mit E-Mail und Passwort. */
const CREDENTIAL_PROVIDER = 'credential';

/** Postgres: unique_violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * Ein Konto, wie die Oberfläche es kennt. `$id`/`$createdAt` sind die Feldnamen
 * aus `lib/db`, damit die Seiten nicht zwei Schreibweisen kennen müssen.
 */
export interface PublicUser {
  $id: string;
  $createdAt: string;
  email: string;
  name: string;
  totpEnabled: boolean;
  passkeyCount: number;
  lastLoginAt: string | null;
}

interface AuthUserRecord {
  $id: string;
  $createdAt: string;
  name: string;
  email: string;
}

type AdapterUser = {
  id: string;
  name?: string | null;
  email: string;
  createdAt?: Date | string | null;
};

function toRecord(user: AdapterUser): AuthUserRecord {
  const created = user.createdAt ? new Date(user.createdAt) : null;
  return {
    $id: user.id,
    // Die Spalte ist Pflicht. Der Rückfall steht da, weil `createdAt` im Typ des
    // Adapters fehlen darf und ein `Invalid Date` in der Liste schlechter wäre.
    $createdAt: (created && !Number.isNaN(created.getTime()) ? created : new Date(0)).toISOString(),
    name: user.name ?? '',
    email: user.email,
  };
}

async function context() {
  return (await auth()).$context;
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Drizzle reicht den Fehler der Datenbank als `cause` weiter. */
function isUniqueViolation(err: unknown): boolean {
  const error = err as { code?: unknown; cause?: { code?: unknown } } | null;
  return error?.code === UNIQUE_VIOLATION || error?.cause?.code === UNIQUE_VIOLATION;
}

export async function countUsers(): Promise<number> {
  return (await context()).internalAdapter.countTotalUsers();
}

/**
 * Alle Konten, nach Adresse sortiert.
 *
 * `listUsers()` des Adapters setzt ohne Argument kein `LIMIT`, anders als
 * `listDocuments`. Eine stille Obergrenze wäre hier auch falsch: die Liste ist
 * die Antwort auf „wer kommt in dieses Werkzeug hinein".
 */
export async function listUsers(): Promise<PublicUser[]> {
  const ctx = await context();
  const [users, twoFactor, states, passkeys] = await Promise.all([
    ctx.internalAdapter.listUsers() as Promise<AdapterUser[]>,
    listAll<TwoFactorConfig>(COLLECTIONS.TWO_FACTOR),
    listAll<UserState>(COLLECTIONS.USER_STATE),
    countPasskeysByUser(),
  ]);
  const withTotp = new Set(twoFactor.filter((row) => row.enabled).map((row) => row.userId));
  const lastLogin = new Map(states.map((row) => [row.$id, row.lastLoginAt]));

  return users
    .map(toRecord)
    .map((user) => ({
      ...user,
      totpEnabled: withTotp.has(user.$id),
      passkeyCount: passkeys.get(user.$id) ?? 0,
      lastLoginAt: lastLogin.get(user.$id) ?? null,
    }))
    .sort((a, b) => a.email.localeCompare(b.email));
}

export async function getUser(id: string): Promise<PublicUser | null> {
  return (await listUsers()).find((user) => user.$id === id) ?? null;
}

/** Better-Auth schreibt die Adresse selbst klein, beim Anlegen wie beim Suchen. */
export async function findUserByEmail(email: string): Promise<{ $id: string; email: string; name: string } | null> {
  const found = await (await context()).internalAdapter.findUserByEmail(normaliseEmail(email));
  return found?.user ? toRecord(found.user as AdapterUser) : null;
}

/**
 * Konto anlegen, mit Passwort.
 *
 * Zwei Zeilen, in dieser Reihenfolge: das Konto in `auth_users`, der Zugang in
 * `auth_accounts`. Genau das macht `signUpEmail` intern auch.
 *
 * `emailVerified: true`: Konten legt an, wer schon eines hat, eine
 * Bestätigungsmail fordert niemand an.
 *
 * `id` setzt nur die Ersteinrichtung. Dort ist die feste Kennung der Schutz vor
 * zwei gleichzeitigen Anfragen: die zweite läuft in den Primärschlüssel.
 */
export async function createUser(input: {
  email: string;
  name: string;
  password: string;
  id?: string;
}): Promise<PublicUser> {
  const email = normaliseEmail(input.email);
  const name = input.name.trim();
  if (!validateEmail(email)) throw new ApiError(msg('Die E-Mail-Adresse ist ungültig.'));
  if (!name || name.length > 100) throw new ApiError(msg('Der Name fehlt oder ist zu lang.'));
  const passwordError = validatePassword(input.password);
  if (passwordError) throw new ApiError(passwordError);

  const duplicate = new ApiError(msg('Für diese E-Mail-Adresse gibt es schon ein Konto.'), 409);
  if (await findUserByEmail(email)) throw duplicate;

  const ctx = await context();
  const hash = await ctx.password.hash(input.password);

  let created: AdapterUser | null;
  try {
    created = (await ctx.internalAdapter.createUser({
      ...(input.id ? { id: input.id } : {}),
      name,
      email,
      emailVerified: true,
    })) as AdapterUser | null;
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicate;
    throw err;
  }
  // Ohne Zeile darf kein Zugang entstehen, sonst stünde ein Passwort ohne Konto da.
  if (!created) throw new Error('Das Konto konnte nicht angelegt werden.');

  await ctx.internalAdapter.linkAccount({
    userId: created.id,
    providerId: CREDENTIAL_PROVIDER,
    accountId: created.id,
    password: hash,
  });

  return { ...toRecord(created), totpEnabled: false, passkeyCount: 0, lastLoginAt: null };
}

async function credentialHash(userId: string): Promise<string | null> {
  const ctx = await context();
  const accounts = (await ctx.internalAdapter.findAccounts(userId)) as {
    providerId: string;
    password?: string | null;
  }[];
  return accounts.find((account) => account.providerId === CREDENTIAL_PROVIDER)?.password ?? null;
}

/** Stimmt das Passwort dieses Kontos? Für Schritte, die eine offene Sitzung allein nicht tragen soll. */
export async function verifyPassword(userId: string, password: string): Promise<boolean> {
  const hash = await credentialHash(userId);
  if (!hash) return false;
  return (await context()).password.verify({ hash, password });
}

/**
 * Das eigene Passwort ändern. Verlangt das aktuelle.
 *
 * Ein Konto ohne `credential`-Zeile bekäme über `updatePassword` stillschweigend
 * kein Passwort. Das gibt es hier nicht (jedes Konto entsteht mit einem), und
 * ohne Zeile scheitert schon die Prüfung des aktuellen.
 */
export async function changePassword(userId: string, current: string, next: string): Promise<void> {
  if (!(await verifyPassword(userId, current))) throw new ApiError(msg('Das aktuelle Passwort stimmt nicht.'));
  const passwordError = validatePassword(next);
  if (passwordError) throw new ApiError(passwordError);

  const ctx = await context();
  await ctx.internalAdapter.updatePassword(userId, await ctx.password.hash(next));
}

/**
 * Eine Zeile in `user_state` ändern, und anlegen, wenn es sie noch nicht gibt.
 * Scheitert nie nach außen: `what` steht im Log.
 */
async function patchUserState(userId: string, patch: Partial<UserState>, what: string): Promise<void> {
  try {
    await updateDocument<UserState>(COLLECTIONS.USER_STATE, userId, patch);
  } catch (err) {
    if (!(err instanceof NotFoundError)) {
      console.error(`[auth] ${what} nicht vermerkt:`, err);
      return;
    }
    await createDocument<UserState>(COLLECTIONS.USER_STATE, { lastLoginAt: null, ...patch }, userId).catch(
      (createErr) => {
        console.error(`[auth] ${what} nicht vermerkt:`, createErr);
      }
    );
  }
}

/** Eine abgeschlossene Anmeldung festhalten. Die Anmeldung gilt auch ohne den Vermerk. */
export async function recordLogin(userId: string): Promise<void> {
  await patchUserState(userId, { lastLoginAt: new Date().toISOString() }, 'Letzte Anmeldung');
}

/** Die gewählte Sprache des Kontos, `null` ohne Wahl. */
export async function getUserLocale(userId: string): Promise<Locale | null> {
  try {
    const state = await getDocument<UserState>(COLLECTIONS.USER_STATE, userId);
    return isLocale(state.locale) ? state.locale : null;
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}

/** Ob das Fenster „Konto absichern“ für dieses Konto schon weggeklickt wurde. */
export async function securityPromptDismissed(userId: string): Promise<boolean> {
  try {
    const state = await getDocument<UserState>(COLLECTIONS.USER_STATE, userId);
    return !!state.securityPromptDismissedAt;
  } catch (err) {
    if (err instanceof NotFoundError) return false;
    throw err;
  }
}

/** Das Fenster „Konto absichern“ nicht mehr zeigen. Wirft, wie die Sprache: sonst käme es wieder. */
export async function dismissSecurityPrompt(userId: string): Promise<void> {
  const securityPromptDismissedAt = new Date().toISOString();
  try {
    await updateDocument<UserState>(COLLECTIONS.USER_STATE, userId, { securityPromptDismissedAt });
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
    await createDocument<UserState>(COLLECTIONS.USER_STATE, { lastLoginAt: null, securityPromptDismissedAt }, userId);
  }
}

/** Die Sprache am Konto speichern. Anders als die letzte Anmeldung muss das klappen: es wirft. */
export async function setUserLocale(userId: string, locale: Locale): Promise<void> {
  try {
    await updateDocument<UserState>(COLLECTIONS.USER_STATE, userId, { locale });
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
    await createDocument<UserState>(COLLECTIONS.USER_STATE, { lastLoginAt: null, locale }, userId);
  }
}

/**
 * Konto löschen, samt Zugängen, Sitzungen und Passkeys.
 *
 * `deleteUser` des Adapters räumt `auth_accounts` und `auth_sessions` mit ab,
 * die Passkeys hängen am Fremdschlüssel: wer gelöscht wird, ist sofort draußen.
 */
export async function deleteUser(userId: string, actingUserId: string): Promise<void> {
  if (userId === actingUserId) throw new ApiError(msg('Das eigene Konto lässt sich nicht löschen.'));
  if ((await countUsers()) <= 1) throw new ApiError(msg('Das letzte Konto lässt sich nicht löschen.'));

  await (await context()).internalAdapter.deleteUser(userId);

  await remove2FA(userId);
  await deleteDocument(COLLECTIONS.USER_STATE, userId);
}
