/**
 * Der Anmeldedienst von HAPM: Better-Auth mit den Vorgaben aus `./core`.
 *
 * ── Warum es nicht eine Instanz gibt, die beim Start gebaut wird ──
 *
 * HAPM kennt seine Adresse beim Start nicht. Nach der Installation ist es
 * zuerst über `http://<adresse>:7080` zu erreichen und bekommt seine Adresse
 * erst später, in den Einstellungen (`publicUrl`), nicht aus der Umgebung.
 * Zwei Dinge hängen daran und stehen deshalb nicht fest:
 *
 *  - **Die Domain der Passkeys** (`rpID`) und ihre erlaubte Herkunft. Beides
 *    kommt aus `publicUrl`. Ohne sie hat die Instanz keine Passkeys.
 *  - **Ob die Cookies `Secure` tragen.** Über HTTPS ja, über `http://<adresse>:7080`
 *    nein: der Browser nähme sie dort nicht an, und niemand käme mehr hinein.
 *    Better-Auth legt das beim Bauen fest (samt Vorsilbe `__Secure-` im Namen),
 *    also gibt es je Fall eine Instanz.
 *
 * `auth()` liest deshalb bei jedem Aufruf die Einstellungen und die Anfrage und
 * gibt die passende Instanz zurück. Ändert sich `publicUrl`, entstehen neue.
 * Alle teilen sich Verbindung, Geheimnis und Tabellen.
 *
 * ── `baseURL` ──
 *
 * `publicUrl`, sonst ein lokaler Platzhalter. Gebraucht wird sie hier fast
 * nicht: HAPM hängt den HTTP-Handler von Better-Auth nirgends ein, jeder Aufruf
 * geht als `auth().api.*` durch eine eigene Route. Die Herkunftsprüfung von
 * Better-Auth läuft dabei nicht (sie braucht die Anfrage, übergeben werden nur
 * die Kopfzeilen), den Schutz vor fremden Seiten leistet `requireCsrf`. Deshalb
 * funktioniert die Anmeldung über die IP-Adresse genauso wie über die Domain.
 * Den Link der Passwort-Mail baut `resetPasswordUrl` selbst.
 *
 * Keine Selbstregistrierung: Konten legt an, wer schon eines hat.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { headers } from 'next/headers';
import { createAuth, type AuthInstance } from './core';
import { sql } from '../db/postgres-driver';
import { getClientIP } from '../audit';
import { secrets } from '../secrets';
import { getSettings } from '../settings';
import { sendAuthMail } from './mail';
import { passkeyRelyingParty } from './passkey-rules';

export const APP_NAME = 'HAPM';

/** Steht in keiner Mail und in keinem Cookie, siehe „baseURL" oben. */
const LOCAL_BASE_URL = `http://localhost:${process.env.PORT || '7080'}`;

/**
 * Ob die Anfrage über HTTPS kam. Das eigene HAProxy setzt `X-Forwarded-Proto`,
 * direkt über den Port von HAPM fehlt die Kopfzeile.
 *
 * Außerhalb einer Anfrage (Start, Tests) gibt es keine Kopfzeilen: dann nein.
 */
export async function isSecureRequest(): Promise<boolean> {
  try {
    const h = await headers();
    return h.get('x-forwarded-proto')?.split(',')[0].trim() === 'https';
  } catch {
    return false;
  }
}

/**
 * Die Kopfzeilen der Anfrage für einen Aufruf, der eine Sitzung anlegt.
 *
 * Better-Auth schreibt die Adresse des Aufrufers aus `X-Forwarded-For` in die
 * Sitzung. Die Kopfzeile kann bei direktem Zugriff jeder selbst setzen. Hier
 * steht deshalb die Adresse, die `getClientIP` für echt hält.
 */
export async function sessionHeaders(request: Request): Promise<Headers> {
  const copy = new Headers(await headers());
  const ip = getClientIP(request);
  if (ip === 'unknown') copy.delete('x-forwarded-for');
  else copy.set('x-forwarded-for', ip);
  return copy;
}

interface Built {
  publicUrl: string | null;
  bySecure: Map<boolean, AuthInstance>;
}

// Next lädt ein Modul je Route neu. Die Instanzen sollen für alle dieselben sein.
const globalForAuth = globalThis as unknown as { __hapmAuth?: Built };

function build(publicUrl: string | null, secure: boolean): AuthInstance {
  const relyingParty = passkeyRelyingParty(publicUrl);

  return createAuth({
    // Dieselbe Verbindung wie der Rest von HAPM, kein zweiter Pool.
    db: drizzle(sql()),

    appName: APP_NAME,
    secret: secrets().sessionSecret,
    baseURL: publicUrl ?? LOCAL_BASE_URL,
    selfSignUp: false,

    resetPasswordUrl: (token) => {
      // `/api/auth/forgot-password` lehnt vorher ab, wenn die Adresse fehlt.
      if (!publicUrl) throw new Error('Ohne die Adresse von HAPM gibt es keinen Link zum Zurücksetzen.');
      return `${publicUrl}/reset-password?token=${encodeURIComponent(token)}`;
    },

    sendMail: sendAuthMail,

    useSecureCookies: secure,

    /*
     * Die Domain kommt aus der Adresse von HAPM. Ändert sie sich, sind die
     * hinterlegten Passkeys wertlos (`passkey-rules.ts`).
     *
     * `./core` nimmt nur Passkeys an, bei denen das Gerät die Person geprüft
     * hat (Fingerabdruck, Gesicht oder PIN). Darauf stützt sich
     * `/api/auth/passkey/login/verify`, wenn es nach einer solchen Anmeldung
     * den Nachweis des zweiten Faktors ausstellt.
     */
    ...(relyingParty ? { passkey: { rpID: relyingParty.rpID, origin: relyingParty.origin } } : {}),

    onLog: ({ message, error }) => {
      console.warn('[auth]', message, error ?? '');
    },
  });
}

export async function auth(): Promise<AuthInstance> {
  const { publicUrl } = await getSettings();
  const secure = await isSecureRequest();

  let built = globalForAuth.__hapmAuth;
  if (!built || built.publicUrl !== publicUrl) {
    built = { publicUrl, bySecure: new Map() };
    globalForAuth.__hapmAuth = built;
  }

  let instance = built.bySecure.get(secure);
  if (!instance) {
    instance = build(publicUrl, secure);
    built.bySecure.set(secure, instance);
  }
  return instance;
}

/** Nur für Tests: die Instanzen halten eine Verbindung fest. */
export function resetAuth(): void {
  globalForAuth.__hapmAuth = undefined;
}
