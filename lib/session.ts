/**
 * Die Sitzung, aus dem Anmeldedienst (`lib/auth/config.ts`), mit der Form nach
 * außen, die alle Routen kennen: `getSession`, `requireSession`, `requireCsrf`
 * und `SessionData`. Die Bibliothek liegt hinter dieser Form, statt dass sich
 * die Aufrufstellen an sie anpassen: wechselt sie, bleiben die Routen stehen.
 *
 * Der Cookie trägt ein Token, die Sitzung selbst steht in `auth_sessions`.
 * Abmelden ist damit eine gelöschte Zeile und wirkt sofort. Cookie-Name,
 * Laufzeit und Flags setzt Better-Auth.
 *
 * Eine Sitzung endet eine Woche nach der Anmeldung. Better-Auth verlängert
 * zwar die Zeile bei Nutzung, schickt den erneuerten Cookie aber mit der
 * Antwort seines eigenen Aufrufs, und die reicht hier nur die Anmeldung an den
 * Browser weiter.
 *
 * Der zweite Faktor hat seinen eigenen Nachweis, siehe `lib/two-factor.ts`.
 */

import { headers } from 'next/headers';
import { createHmac } from 'node:crypto';
import { auth } from './auth/config';
import { validateCsrfToken } from './csrf';
import { pruneAuthTables } from './db/auth-tables';
import { secrets } from './secrets';
import { has2FAEnabled, check2FAVerified } from './two-factor';
import type { SessionData } from './types';

/**
 * Der CSRF-Token wird aus dem Token der Sitzung abgeleitet, nicht gespeichert:
 * je Sitzung verschieden, ohne die Sitzung nicht berechenbar, und er verfällt
 * mit ihr. Exportiert, weil die Anmeldung ihn braucht, bevor der Cookie der
 * neuen Sitzung mit einer Anfrage zurückkommt.
 *
 * Mit einer Vorsilbe vor dem Token. Better-Auth signiert seinen Cookie mit
 * demselben Geheimnis über dasselbe Token: ohne die Vorsilbe wäre der
 * CSRF-Token, den die Oberfläche lesen darf, die Signatur des Cookies, den sie
 * nicht lesen darf.
 */
export function csrfFor(sessionToken: string): string {
  return createHmac('sha256', secrets().sessionSecret).update(`hapm-csrf:${sessionToken}`).digest('base64url');
}

/** Nur lesend: Anmelden und Abmelden laufen über die Routen unter `/api/auth`. */
export type Session = Readonly<SessionData>;

const ANONYMOUS: Session = Object.freeze({
  userId: '',
  email: '',
  name: '',
  twoFactorVerified: false,
  twoFactorSetupRequired: false,
  csrfToken: '',
});

export async function getSession(): Promise<Session> {
  const result = await (await auth()).api.getSession({ headers: await headers() });
  if (!result?.session || !result.user) return ANONYMOUS;

  const userId = result.user.id;
  const token = result.session.token;

  return Object.freeze({
    userId,
    email: result.user.email,
    name: result.user.name,
    // Ohne eingerichteten zweiten Faktor gibt es nichts zu bestätigen.
    twoFactorVerified: (await has2FAEnabled(userId)) ? await check2FAVerified(userId, token) : true,
    // In HAPM ist der zweite Faktor freiwillig.
    twoFactorSetupRequired: false,
    csrfToken: csrfFor(token),
  });
}

/**
 * Das Token der Sitzung dieser Anfrage. Nur für die Stellen, die den Nachweis
 * des zweiten Faktors daran binden: es steht mit Absicht nicht in `SessionData`,
 * damit es in keiner Antwort und in keinem Protokoll landet.
 */
export async function currentSessionToken(): Promise<string> {
  const result = await (await auth()).api.getSession({ headers: await headers() });
  if (!result?.session) throw new Error('Unauthorized');
  return result.session.token;
}

/** Angemeldet, und ein eingerichteter zweiter Faktor ist in dieser Sitzung gezeigt. */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session.userId) throw new Error('Unauthorized');
  if (!session.twoFactorVerified) throw new Error('2FA-Verifizierung erforderlich');
  return session;
}

/**
 * Für alles, was einen neuen Zugang zum Konto anlegt oder einen vorhandenen
 * verwaltet (Passkeys).
 *
 * Heute dasselbe wie `requireSession`: der zweite Faktor ist in HAPM
 * freiwillig, und wer keinen hat, hat mit dem Passwort alles gezeigt, was das
 * Konto verlangt. Die Funktion steht trotzdem für sich, damit diese Routen
 * sagen, was sie meinen, und damit eine spätere Pflicht zum zweiten Faktor an
 * einer Stelle einzuschalten wäre.
 */
export async function requireVerifiedSession(): Promise<Session> {
  return requireSession();
}

/** Nach dem Passwort, vor dem zweiten Faktor. Nur für die Routen der Bestätigung und das Abmelden. */
export async function requirePartialSession(): Promise<Session> {
  const session = await getSession();
  if (!session.userId) throw new Error('Unauthorized');
  return session;
}

/**
 * Den CSRF-Token prüfen. Gehört in jede schreibende Route.
 *
 * Der leere Token einer nicht angemeldeten Anfrage wird vorher abgefangen,
 * sonst verglichen zwei leere Zeichenketten erfolgreich miteinander.
 */
export async function requireCsrf(request: Request): Promise<void> {
  const session = await getSession();
  const headerToken = request.headers.get('X-CSRF-Token');
  if (!session.csrfToken || !validateCsrfToken(headerToken, session.csrfToken)) {
    throw new Error('Ungültiger CSRF-Token');
  }
}

/** Alle anderen Sitzungen des angemeldeten Kontos beenden, etwa nach einem neuen Passwort. */
export async function revokeOtherSessions(): Promise<void> {
  await (await auth()).api.revokeOtherSessions({ headers: await headers() });
}

/**
 * Abgelaufene Sitzungen und verbrauchte oder verfallene Einmalwerte entfernen
 * (Links zum Zurücksetzen, Aufgaben für Passkeys). Better-Auth räumt nur ab,
 * was jemand noch einmal vorzeigt. Der Scheduler ruft das täglich.
 */
export async function pruneExpiredSessions(): Promise<number> {
  return pruneAuthTables();
}
