/**
 * Der zweite Faktor (TOTP): seine Zeile je Konto und sein eigener Nachweis
 * neben der Sitzung.
 *
 * ── Warum der Nachweis ein eigener Cookie ist ──
 *
 * Die Sitzung liegt in `auth_sessions` und gehört dem Anmeldedienst. „In dieser
 * Sitzung bestätigt" dort als Spalte zu führen hieße, dessen Tabelle um etwas
 * zu erweitern, das nur HAPM kennt. Also ein eigener, signierter Cookie mit
 * genau einer Aussage: dieses Konto hat in dieser Sitzung seinen zweiten Faktor
 * gezeigt, und zwar bis dann. Kein Speicher, nichts aufzuräumen, der Nachweis
 * verfällt von selbst.
 *
 * ── Was für den Nachweis gilt ──
 *
 * Der zweite Faktor ist freiwillig. Ein Konto ohne Zeile (oder mit einer, deren
 * Einrichtung nie abgeschlossen wurde) ist nach dem Passwort angemeldet.
 *
 * Der Nachweis ist an die Sitzung gebunden, nicht nur an das Konto: ihr Token
 * steht mit in der Signatur. Eine zweite Anmeldung im selben Browser bringt
 * eine neue Sitzung mit, und für die gilt der alte Nachweis nicht.
 *
 * Es gibt keine Wiederherstellungscodes. Wer seine App verliert, braucht den
 * Zugang zum Server (`hapm-admin reset-password`).
 */

import { cookies } from 'next/headers';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createDocument, deleteDocument, listDocuments, updateDocument, Query, type WithMeta } from './db';
import { isSecureRequest } from './auth/config';
import { secrets } from './secrets';
import { decryptTOTPSecret, encryptTOTPSecret } from './totp';
import { COLLECTIONS, type TwoFactorConfig } from './types';

const COOKIE_NAME = 'hapm_2fa';

/**
 * 24 Stunden, bewusst kürzer als die Sitzung (eine Woche, bei Nutzung länger).
 * Die Sitzung sagt, wer da ist. Der zweite Faktor sagt: gerade eben, an diesem
 * Gerät. Eine Woche alt wäre das keine Aussage mehr.
 */
const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * `sessionSecret` und nicht `encryptionKey`: wer das Geheimnis erneuert, will
 * alle abmelden und den zweiten Faktor neu verlangen. `encryptionKey` darf sich
 * nie ändern (er hält die TOTP-Geheimnisse selbst) und taugt deshalb nicht.
 */
function signingKey(): string {
  return secrets().sessionSecret;
}

/**
 * Die Zeile eines Kontos, oder `null`.
 *
 * **Ein Fehler der Datenbank wird nicht geschluckt.** `null` heißt „kein
 * zweiter Faktor eingerichtet", und ein solches Konto ist nach dem Passwort
 * angemeldet. Eine nicht erreichbare Datenbank dürfte sonst die Sperre öffnen.
 */
export async function get2FAConfig(userId: string): Promise<WithMeta<TwoFactorConfig> | null> {
  const rows = await listDocuments<TwoFactorConfig>(COLLECTIONS.TWO_FACTOR, [
    Query.equal('userId', userId),
    Query.limit(1),
  ]);
  return rows[0] ?? null;
}

/**
 * Gilt der zweite Faktor für dieses Konto?
 *
 * Allein `enabled` entscheidet, auch wenn das Geheimnis nicht mehr lesbar ist.
 * Ein unlesbares Geheimnis sperrt aus, statt stillschweigend als „nie
 * eingerichtet" zu gelten: das wäre ein Weg an der Sperre vorbei.
 */
export async function has2FAEnabled(userId: string): Promise<boolean> {
  return (await get2FAConfig(userId))?.enabled === true;
}

/**
 * Das entschlüsselte Geheimnis, oder `null`. Wirft nicht: ein Geheimnis, das
 * sich nicht öffnen lässt, ist ein abgelehnter Code. Der Grund steht im Log.
 */
export async function get2FASecret(userId: string): Promise<string | null> {
  const config = await get2FAConfig(userId);
  if (!config?.secret) return null;
  try {
    return decryptTOTPSecret(config.secret);
  } catch (err) {
    console.error('[two-factor] TOTP-Geheimnis nicht entschlüsselbar:', err);
    return null;
  }
}

/** Ein neues Geheimnis ablegen. Es gilt erst nach `enable2FA`. */
export async function store2FASecret(userId: string, secret: string): Promise<void> {
  const existing = await get2FAConfig(userId);
  const data = { secret: encryptTOTPSecret(secret), enabled: false };
  if (existing) await updateDocument<TwoFactorConfig>(COLLECTIONS.TWO_FACTOR, existing.$id, data);
  else await createDocument<TwoFactorConfig>(COLLECTIONS.TWO_FACTOR, { userId, ...data });
}

export async function enable2FA(config: WithMeta<TwoFactorConfig>): Promise<void> {
  await updateDocument<TwoFactorConfig>(COLLECTIONS.TWO_FACTOR, config.$id, { enabled: true });
}

/** Den zweiten Faktor eines Kontos entfernen. Liefert, ob es einen gab. */
export async function remove2FA(userId: string): Promise<boolean> {
  const rows = await listDocuments<TwoFactorConfig>(COLLECTIONS.TWO_FACTOR, [
    Query.equal('userId', userId),
    Query.limit(100),
  ]);
  for (const row of rows) await deleteDocument(COLLECTIONS.TWO_FACTOR, row.$id);
  return rows.length > 0;
}

function signature(userId: string, expiry: string, sessionToken: string): string {
  return createHmac('sha256', signingKey()).update(`${userId}:${expiry}:${sessionToken}`).digest('base64url');
}

/** Der Wert des Cookies. Das Token der Sitzung steht nur in der Signatur, nicht im Wert. */
export function sign2FAToken(userId: string, sessionToken: string, now = Date.now()): string {
  const expiry = String(now + TOKEN_EXPIRY_MS);
  return Buffer.from(`${userId}:${expiry}:${signature(userId, expiry, sessionToken)}`).toString('base64url');
}

/**
 * Gilt der Nachweis für dieses Konto, diese Sitzung und noch?
 *
 * Die drei Prüfungen laufen alle, keine kürzt ab: sonst hinge die Laufzeit
 * daran, welche zuerst scheitert.
 */
export function verify2FAToken(token: string, userId: string, sessionToken: string, now = Date.now()): boolean {
  try {
    if (!sessionToken) return false;
    const parts = Buffer.from(token, 'base64url').toString('utf-8').split(':');
    if (parts.length !== 3) return false;
    const [tokenUser, expiry, provided] = parts;

    const a = Buffer.from(provided);
    const b = Buffer.from(signature(tokenUser, expiry, sessionToken));
    const signatureValid = a.length === b.length && timingSafeEqual(a, b);

    const userA = Buffer.from(tokenUser);
    const userB = Buffer.from(userId);
    const userValid = userA.length === userB.length && timingSafeEqual(userA, userB);

    const until = Number(expiry);
    const notExpired = !Number.isNaN(until) && now <= until;

    return signatureValid && userValid && notExpired;
  } catch {
    return false;
  }
}

/**
 * Den Nachweis ausstellen: nach einem gültigen Code oder einer Anmeldung mit
 * Passkey.
 *
 * `sameSite: 'strict'` und nicht `'lax'` wie der Cookie der Sitzung: der
 * Nachweis sagt „hier, gerade eben bestätigt", und ein Aufruf, der auf einer
 * fremden Seite beginnt, ist der Fall, in dem das nicht gelten soll.
 */
export async function set2FACookie(userId: string, sessionToken: string): Promise<void> {
  (await cookies()).set(COOKIE_NAME, sign2FAToken(userId, sessionToken), {
    httpOnly: true,
    secure: await isSecureRequest(),
    sameSite: 'strict',
    path: '/',
    maxAge: TOKEN_EXPIRY_MS / 1000,
  });
}

/** Beim Abmelden und vor jeder neuen Anmeldung. */
export async function clear2FACookie(): Promise<void> {
  (await cookies()).delete(COOKIE_NAME);
}

export async function check2FAVerified(userId: string, sessionToken: string): Promise<boolean> {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (!token) return false;
  return verify2FAToken(token, userId, sessionToken);
}
