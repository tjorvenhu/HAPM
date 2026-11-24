/**
 * Der Kern der Anmeldung: Better-Auth mit den Vorgaben von HAPM.
 *
 * **Keine eigene Authentifizierung.** Das war die Entscheidung, und sie steht:
 * OAuth-State und PKCE, Token-Rotation mit Reuse-Detection, Session-Fixation,
 * Timing bei der Passwortprüfung, E-Mail-Enumeration, Account-Linking,
 * TOTP-Replay — jeder Punkt ist bekannt und wird trotzdem regelmäßig falsch
 * gemacht, und der Fehler fällt nicht auf, bis er auffällt. Better-Auth läuft
 * auf dem Postgres aus dem eigenen Stack, ohne Vendor, ohne Hosting.
 *
 * **Was dieser Ordner dann überhaupt tut**: er hält die Entscheidungen an einer
 * Stelle fest — wie lange ein Reset-Link gilt, wie eine Sitzung altert, wie die
 * Cookies über Unterdomänen hinweg gesetzt werden, wie die Mails klingen. Und
 * er ist die Fassade, hinter der Better-Auth austauschbar bleibt: der Rest von
 * HAPM importiert `createAuth`, nicht `betterAuth`. Was HAPM selbst festlegt
 * (Adresse, Tabellen, Versand, Passkeys), steht in `lib/auth/config.ts`.
 */

import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { APIError } from 'better-auth/api';
import { passkey } from '@better-auth/passkey';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { and, eq } from 'drizzle-orm';
import { authAccounts, authSchemaMap } from './schema';
import { resetPasswordMail, verifyEmailMail, type MailContent } from './mail';

/** Eine Stunde. Siehe `resetPasswordTokenExpiresIn` unten. */
export const RESET_TOKEN_TTL_SECONDS = 60 * 60;

/** Eine Woche, bei Nutzung verlängert. Siehe `session`. */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
export const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;

/**
 * Zehn Zeichen.
 *
 * Nicht acht: Better-Auth hasht mit scrypt, aber Länge ist der einzige Faktor,
 * den der Betreiber vorgeben kann. Nicht mehr als zehn, weil eine höhere
 * Mindestlänge erfahrungsgemäß zu Zetteln am Monitor führt statt zu besseren
 * Passwörtern.
 */
export const MIN_PASSWORD_LENGTH = 10;

/**
 * Ein Passwort-Hash aus einem Vorgängersystem.
 *
 * ── Warum das eine benannte Option ist und kein `extend` ──
 *
 * Wer von einem anderen Anmeldedienst kommt, hat Hashes in dessen Verfahren —
 * Argon2 etwa, oder bcrypt. Umrechnen geht nicht: ein Hash gibt das Passwort
 * nicht her. Es bleiben zwei Wege, und nur einer ist zumutbar. Alle zum
 * Zurücksetzen zu zwingen ist eine Mail an jedes Konto, die aussieht wie ein
 * Einbruch. Der andere ist, den alten Hash beim ersten
 * erfolgreichen Anmelden gegen einen neuen zu tauschen — niemand merkt etwas,
 * und der alte Zweig läuft mit der Zeit leer.
 *
 * Das Verfahren dazu steht hier und nicht beim Aufrufer: die
 * Fallunterscheidung, das Beibehalten von scrypt für alles Neue und vor allem
 * das Nachziehen nach erfolgreicher Prüfung sind drei Stellen, an denen man
 * einzeln falsch abbiegen kann. Der Aufrufer liefert nur, was er allein weiß:
 * wie ein alter Hash aussieht und wie man ihn prüft.
 */
export interface LegacyPasswordSupport {
  /**
   * Erkennt einen Hash des Vorgängersystems an seiner Form.
   *
   * Muss verlässlich `false` liefern für Hashes von Better-Auth (scrypt,
   * `salz:hash` in Hex). Bei Argon2 und bcrypt genügt das führende `$`.
   */
  matches: (hash: string) => boolean;

  /** Prüft ein Passwort gegen einen solchen Hash. */
  verify: (params: { hash: string; password: string }) => Promise<boolean>;
}

/**
 * Anmelden mit Passkey (WebAuthn).
 *
 * ── Was ein Passkey hier ist ──
 *
 * Ein zusätzlicher Weg neben Passwort und zweitem Faktor, kein Ersatz für das
 * Konto: Passwort und TOTP bleiben bestehen, und wer sein Gerät verliert,
 * meldet sich darüber an und entfernt den Passkey. So halten es die großen
 * Anbieter, und so erwartet es, wer von dort kommt.
 *
 * ── Warum die Bestätigung der Person Pflicht ist ──
 *
 * Eine Anmeldung per Passkey gilt hier als beide Faktoren zugleich: das Gerät
 * (Besitz) und Fingerabdruck, Gesicht oder PIN (Person). Das stimmt nur, wenn
 * das Gerät die Person wirklich geprüft hat. WebAuthn überlässt das dem
 * Aufrufer: ohne Vorgabe genügt es, einen Sicherheitsschlüssel zu berühren,
 * und das ist ein Faktor, nicht zwei. Das Plugin fragt nur „bevorzugt" danach
 * und prüft es nicht. HAPM verlangt es beim Hinterlegen und lehnt jede
 * Anmeldung ab, bei der das Gerät die Prüfung nicht bestätigt.
 */
export interface PasskeySupport {
  /**
   * Die Domain, an die jeder Passkey gebunden wird, ohne Protokoll und Port:
   * `example.org`, lokal `localhost`.
   *
   * **Lässt sich nachträglich nicht ändern.** Ein Passkey gilt nur für die
   * Domain, für die er angelegt wurde. Wer sie wechselt, entwertet alle
   * hinterlegten Passkeys, und die Benutzer merken es erst beim Anmelden.
   * Eine Unterdomäne der Anwendung ist erlaubt (`example.org` für
   * `portal.example.org`), eine fremde Domain nicht.
   */
  rpID: string;
  /** Name, den das Gerät beim Anlegen zeigt. Ohne Angabe `appName`. */
  rpName?: string;
  /**
   * Erlaubte Herkunft der Anfragen, mit Protokoll und ohne Schrägstrich am
   * Ende: `https://example.org`. Ohne Angabe die Herkunft aus `baseURL`.
   */
  origin?: string | string[];
}

/** Die Meldung, wenn ein Gerät die Person nicht geprüft hat. */
export const PASSKEY_NEEDS_USER_VERIFICATION =
  'Dieser Passkey bestätigt die Person nicht (kein Fingerabdruck, Gesicht oder PIN). ' +
  'Er ersetzt deshalb keinen zweiten Faktor und wird nicht angenommen.';

/** Was die Anmeldung zu berichten hat. Siehe `onLog`. */
export type AuthLogEvent = {
  level: 'warn';
  message: string;
  error?: unknown;
};

export interface AuthOptions {
  /** Die Drizzle-Instanz, über die Better-Auth liest und schreibt. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  /**
   * Abweichende Tabellen, falls eigene Spalten gebraucht werden
   * (siehe `authUserColumns` in schema.ts). Ohne Angabe die aus `schema.ts`.
   */
  tables?: Parameters<typeof authSchemaMap>[0];

  /** Anzeigename in Mails, z. B. "HAPM". */
  appName: string;
  /** Signaturgeheimnis. Rotieren loggt alle aus, mehr nicht. */
  secret: string;
  /** Öffentliche Basis-URL der API — Better-Auth baut daraus seine Endpunkte. */
  baseURL: string;

  /**
   * Wohin der Reset-Link zeigt.
   *
   * Auf die **Weboberfläche**, nicht auf die API: Better-Auth baut sich sonst
   * einen Umweg über `/api/auth/reset-password/:token`, der auf eine
   * Rückadresse weiterleitet. Das ist ein Sprung mehr und eine Adresse in der
   * Mail, die nicht aussieht wie die Seite, die man kennt.
   */
  resetPasswordUrl: (token: string) => string;
  verifyEmailUrl?: (token: string) => string;

  /** Versand. Der Kern bringt keinen mit: HAPM verschickt über `lib/mail`. */
  sendMail: (mail: MailContent & { to: string }) => Promise<unknown>;

  /** Erlaubte Herkünfte, wenn Web und API auf verschiedenen Adressen liegen. */
  trustedOrigins?: string[];
  /** Gemeinsame Domäne, wenn Web und API auf Unterdomänen liegen. */
  cookieDomain?: string;
  /** In der Entwicklung ohne HTTPS würde ein `secure`-Cookie nie gesetzt. */
  useSecureCookies?: boolean;

  /**
   * Selbstregistrierung.
   *
   * Aus (Vorgabe) heißt: Konten legt der Betreiber an. Dann ist eine
   * Bestätigungsmail an eine Adresse aus dem eigenen Haus nur eine Hürde ohne
   * Sicherheitsgewinn — deshalb hängt `requireEmailVerification` daran.
   */
  selfSignUp?: boolean;

  /**
   * Übernahme von Passwörtern aus einem Vorgängersystem.
   *
   * Ohne Angabe hasht und prüft Better-Auth wie immer mit scrypt.
   */
  legacyPassword?: LegacyPasswordSupport;

  /**
   * Anmelden mit Passkey. Ohne Angabe gibt es die Endpunkte nicht.
   *
   * Braucht die Tabelle `auth_passkeys`. Wer unter `tables` eigene Tabellen
   * übergibt, muss dort auch `passkey` angeben, sonst wirft der Aufruf: die
   * Vorgabe läge im Schema `public`, und der Adapter suchte die Passkeys an
   * einer Stelle, an der die Tabelle nicht steht.
   */
  passkey?: PasskeySupport;

  /**
   * Wohin die Anmeldung berichtet.
   *
   * **Kein `console.*`** in diesem Ordner: wohin eine Zeile gehört (Audit-Log,
   * Ausgabe des Containers), entscheidet der Aufrufer. Ohne Haken bleibt das
   * Ereignis stumm, und das ist die bewusste Vorgabe: das einzige, was hier
   * berichtet wird, ist ein misslungenes Nachziehen eines alten Hashes, und
   * das ist kein Fehler des Anmeldevorgangs.
   */
  onLog?: (event: AuthLogEvent) => void;

  /**
   * Zusätzliche Better-Auth-Optionen. Fluchtweg, kein Regelfall.
   *
   * **Wird eine Ebene tief zusammengeführt, nicht ersetzt.** Mit einem flachen
   * `...options.extend` am Ende bekäme, wer
   * `{ emailAndPassword: { revokeSessionsOnPasswordReset: true } }` übergibt,
   * genau das und **nichts sonst**: `sendResetPassword`, `minPasswordLength`
   * und `resetPasswordTokenExpiresIn` wären weg. Es ginge dann überhaupt keine
   * Reset-Mail mehr hinaus, und das fällt erst auf, wenn jemand sein Passwort
   * vergisst.
   *
   * Eine Ebene, nicht rekursiv: tiefer wird hier nichts konfiguriert, ein
   * tiefes Verschmelzen wäre also Magie ohne Anlass — und Magie an einer
   * Stelle, die „Fluchtweg" heißt, ist das Letzte, was man will.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extend?: Record<string, any>;
}

/**
 * `extend` über die Vorgaben legen — eine Ebene tief.
 *
 * Objekte werden verschmolzen, alles andere ersetzt. Ein Array bleibt ein
 * Ersetzen: `trustedOrigins: ['a']` soll `['a']` bedeuten und nicht „zur
 * vorhandenen Liste dazu".
 */
function mergeExtend(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  base: Record<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extend: Record<string, any> | undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> {
  if (!extend) return base;

  const out = { ...base };
  for (const [key, value] of Object.entries(extend)) {
    const current = out[key];
    const mergeable =
      isPlainObject(current) && isPlainObject(value);
    out[key] = mergeable ? { ...current, ...value } : value;
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * scrypt, genau wie Better-Auth es sonst selbst täte.
 *
 * Mit eigener Signatur umschlossen, nicht direkt weitergereicht: der Typ von
 * `hashPassword` zeigt auf `@better-auth/utils`, eine transitive Abhängigkeit.
 * Gäbe man die Funktion unverändert in die Konfiguration, verwiese der
 * abgeleitete Rückgabetyp von `createAuth` auf einen Pfad unter `.pnpm/`, und
 * TypeScript kann einen solchen Typ nicht benennen (TS2742).
 */
const scryptHash = (password: string): Promise<string> => hashPassword(password);

/**
 * Prüfen, und einen alten Hash dabei ablösen.
 *
 * Better-Auth reicht der Prüfung nur `{ hash, password }` — keine Konto-ID.
 * Das Nachziehen läuft deshalb über den Hash selbst als Bedingung, und das
 * geht: Argon2 und bcrypt tragen ihr Salz im Hash, zwei Konten haben also
 * praktisch nie denselben. Trifft er wider Erwarten zwei Zeilen, bekommen
 * beide einen gültigen neuen Hash desselben Passworts — auch richtig.
 *
 * Scheitert das Schreiben, gilt das Passwort trotzdem als richtig: es **war**
 * richtig. Der Versuch wiederholt sich beim nächsten Anmelden von allein.
 */
function makeVerify(options: AuthOptions, legacy: LegacyPasswordSupport) {
  const accounts = (options.tables?.account ?? authAccounts) as typeof authAccounts;

  return async ({ hash, password }: { hash: string; password: string }): Promise<boolean> => {
    if (!legacy.matches(hash)) return verifyPassword({ hash, password });

    if (!(await legacy.verify({ hash, password }))) return false;

    try {
      await options.db
        .update(accounts)
        .set({ password: await scryptHash(password) })
        .where(and(eq(accounts.password, hash), eq(accounts.providerId, 'credential')));
    } catch (error) {
      options.onLog?.({
        level: 'warn',
        message:
          'Alter Passwort-Hash konnte nach erfolgreicher Anmeldung nicht ' +
          'abgelöst werden. Die Anmeldung galt; der Versuch wiederholt sich.',
        error,
      });
    }

    return true;
  };
}

/**
 * Das Plugin mit den Vorgaben von HAPM.
 *
 * `residentKey: 'required'` macht den Passkey auffindbar: die Anmeldung fragt
 * dann nicht nach der E-Mail-Adresse, das Gerät bietet die passenden Konten
 * selbst an. Die beiden `afterVerification` setzen durch, was
 * `userVerification: 'required'` nur erbittet (siehe `PasskeySupport`).
 */
function passkeyPlugin(options: AuthOptions, support: PasskeySupport) {
  const origin = support.origin ?? new URL(options.baseURL).origin;
  return passkey({
    rpID: support.rpID,
    rpName: support.rpName ?? options.appName,
    origin,
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    registration: {
      afterVerification: ({ verification }) => {
        if (!verification.registrationInfo?.userVerified) {
          throw new APIError('FORBIDDEN', { message: PASSKEY_NEEDS_USER_VERIFICATION });
        }
      },
    },
    authentication: {
      afterVerification: ({ verification }) => {
        if (!verification.authenticationInfo.userVerified) {
          throw new APIError('FORBIDDEN', { message: PASSKEY_NEEDS_USER_VERIFICATION });
        }
      },
    },
  });
}

export function createAuth(options: AuthOptions) {
  const selfSignUp = options.selfSignUp ?? false;

  if (options.passkey && options.tables && !options.tables.passkey) {
    throw new Error(
      '`passkey` ist gesetzt, aber `tables.passkey` fehlt. Wer eigene Tabellen ' +
        'übergibt, muss auch die Passkey-Tabelle nennen (z. B. aus ' +
        '`authTablesIn(schema)`), sonst sucht der Adapter sie im Schema `public`.'
    );
  }

  /**
   * Die Vorgaben als eigenes Objekt, damit `extend` sie nicht am Typ vorbei
   * überschreibt.
   *
   * `mergeExtend` arbeitet notgedrungen auf `Record<string, any>` — `extend`
   * ist untypisiert, anders geht es nicht. Gäbe man dessen Ergebnis direkt an
   * `betterAuth`, verlöre `ReturnType<typeof createAuth>` seine
   * Ableitung, und `AuthInstance` wäre überall nur noch `any`. Die
   * Rückversicherung auf `typeof config` ist ehrlich: `extend` fügt Schlüssel
   * hinzu oder ersetzt sie, die Form aus Sicht dieser Datei bleibt dieselbe.
   */
  const config = {
    // Die Zuordnung steht ausdrücklich da, statt sich auf Namensgleichheit zu
    // verlassen: Better-Auth sucht `user`, `session`, `account`,
    // `verification`, die Exporte aus `schema.ts` heißen anders. Ohne die Karte fände der
    // Adapter nichts — und zwar erst beim ersten Anmeldeversuch, nicht beim
    // Start.
    database: drizzleAdapter(options.db, {
      provider: 'pg',
      schema: authSchemaMap(options.tables),
    }),

    secret: options.secret,
    baseURL: options.baseURL,

    emailAndPassword: {
      enabled: true,
      requireEmailVerification: selfSignUp,
      minPasswordLength: MIN_PASSWORD_LENGTH,

      sendResetPassword: async ({ user, token }: { user: { email: string; name: string }; token: string }) => {
        const mail = resetPasswordMail({
          appName: options.appName,
          userName: user.name,
          url: options.resetPasswordUrl(token),
          expiresInSeconds: RESET_TOKEN_TTL_SECONDS,
        });
        await options.sendMail({ ...mail, to: user.email });
      },

      /**
       * Eine Stunde. Der Standard von Better-Auth ist länger, aber ein Link,
       * der ein fremdes Konto öffnet, soll nicht bis zum nächsten Morgen im
       * Postfach liegen — und wer ihn anfordert, benutzt ihn in den nächsten
       * Minuten.
       */
      resetPasswordTokenExpiresIn: RESET_TOKEN_TTL_SECONDS,

      /**
       * Alle Sitzungen beenden. **Vorgabe, keine Option.**
       *
       * Better-Auth lässt sie standardmäßig laufen. Wer sein Passwort
       * zurücksetzt, tut das aber genau dann, wenn er annimmt, dass jemand
       * anderes Zugang hat — und dessen Sitzung gilt danach eine Woche weiter.
       * Es gibt keinen Fall, in dem man das anders will; deshalb steht es fest
       * und lässt sich nicht abschalten.
       *
       * Der Wechsel im angemeldeten Zustand (`changePassword`) ist davon
       * unberührt: dort entscheidet der Aufrufer über `revokeOtherSessions`,
       * weil er weiß, ob es eine Vorsichtsmaßnahme oder Routine ist.
       */
      revokeSessionsOnPasswordReset: true,

      /**
       * Passwörter aus einem Vorgängersystem, falls es welche gibt.
       * Ohne die Option bleibt es bei Better-Auths scrypt.
       */
      ...(options.legacyPassword
        ? { password: { hash: scryptHash, verify: makeVerify(options, options.legacyPassword) } }
        : {}),
    },

    ...(selfSignUp && options.verifyEmailUrl
      ? {
          emailVerification: {
            sendOnSignUp: true,
            sendVerificationEmail: async ({
              user,
              token,
            }: {
              user: { email: string; name: string };
              token: string;
            }) => {
              const mail = verifyEmailMail({
                appName: options.appName,
                userName: user.name,
                url: options.verifyEmailUrl!(token),
                expiresInSeconds: RESET_TOKEN_TTL_SECONDS,
              });
              await options.sendMail({ ...mail, to: user.email });
            },
          },
        }
      : {}),

    session: {
      /**
       * Eine Woche, bei Nutzung verlängert. Ein Arbeitsplatz soll sich nicht
       * täglich neu anmelden müssen; ein vergessenes Gerät verfällt trotzdem.
       */
      expiresIn: SESSION_TTL_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
    },

    trustedOrigins: options.trustedOrigins ?? [],

    /**
     * Als `BetterAuthPlugin` und nicht mit dem eigenen Typ des Plugins.
     *
     * Dessen Typ zeigt auf `@simplewebauthn/server` und `zod`, beides
     * Abhängigkeiten des Plugins und nicht von HAPM. Der abgeleitete
     * Rückgabetyp von `createAuth` verwiese damit auf Pfade unter
     * `.pnpm/`, und TypeScript kann einen solchen Typ nicht benennen
     * (TS2742, dieselbe Falle wie bei `scryptHash`). Die Endpunkte sind
     * deshalb über `passkeyApi()` typisiert und nicht über `auth.api`.
     */
    plugins: options.passkey ? [passkeyPlugin(options, options.passkey) as BetterAuthPlugin] : [],

    advanced: {
      useSecureCookies: options.useSecureCookies ?? true,
      // `as const`, seit die Konfiguration in einer Variablen liegt: ohne die
      // Zusicherung leitet TypeScript `string` ab, und Better-Auth verlangt
      // eines der bekannten Wörter.
      defaultCookieAttributes: { sameSite: 'lax' as const },
      // Liegen Web und API auf verschiedenen Unterdomänen, muss das Cookie auf
      // die gemeinsame Domäne ausgestellt werden. Lokal entfällt das: Ports
      // trennen Cookies nicht.
      ...(options.cookieDomain
        ? { crossSubDomainCookies: { enabled: true, domain: options.cookieDomain } }
        : {}),
    },
  };

  return betterAuth(mergeExtend(config, options.extend) as typeof config);
}

export type AuthInstance = ReturnType<typeof createAuth>;

/** Ein hinterlegter Passkey, so wie ihn die Verwaltung im Profil zeigt. */
export interface PasskeyRecord {
  id: string;
  name?: string | null;
  userId: string;
  credentialID: string;
  /** `singleDevice` oder `multiDevice`. */
  deviceType: string;
  /** Mit der Cloud des Herstellers abgeglichen, also auf mehreren Geräten vorhanden. */
  backedUp: boolean;
  createdAt?: Date | string | null;
  aaguid?: string | null;
}

/** Antwort eines Aufrufs mit `returnHeaders: true`: die Cookies stehen in `headers`. */
export interface WithHeaders<T> {
  headers: Headers;
  response: T;
}

/**
 * Die Passkey-Endpunkte, serverseitig aufrufbar.
 *
 * Eigene Typen statt der des Plugins, aus dem Grund, der bei `plugins` steht.
 * Sie beschreiben, was die Routen von HAPM benutzen: wechselt das Plugin,
 * bleibt diese Fläche stehen.
 *
 * Die beiden `generate…`-Aufrufe setzen ein signiertes Cookie mit der
 * Aufgabe (`challenge`). Wer sie aus einer Server-Action ruft, muss die
 * `Set-Cookie`-Zeilen aus `headers` an den Browser weiterreichen, sonst findet
 * der zweite Schritt die Aufgabe nicht.
 */
export interface PasskeyApi {
  /** Braucht eine Sitzung. Liefert die Optionen für `navigator.credentials.create()`. */
  generatePasskeyRegistrationOptions(args: {
    headers: Headers;
    query?: { name?: string; authenticatorAttachment?: 'platform' | 'cross-platform' };
    returnHeaders: true;
  }): Promise<WithHeaders<Record<string, unknown>>>;
  /** Braucht eine Sitzung. Prüft die Antwort des Geräts und speichert den Passkey. */
  verifyPasskeyRegistration(args: {
    headers: Headers;
    body: { response: unknown; name?: string };
  }): Promise<PasskeyRecord | null>;
  /** Ohne Sitzung. Liefert die Optionen für `navigator.credentials.get()`. */
  generatePasskeyAuthenticationOptions(args: {
    headers: Headers;
    returnHeaders: true;
  }): Promise<WithHeaders<Record<string, unknown>>>;
  /** Prüft die Antwort des Geräts und legt die Sitzung an (Cookie in `headers`). */
  verifyPasskeyAuthentication(args: {
    headers: Headers;
    body: { response: Record<string, unknown> };
    returnHeaders: true;
  }): Promise<WithHeaders<{ session: { id: string; userId: string }; user: { id: string; email: string; name: string } }>>;
  listPasskeys(args: { headers: Headers }): Promise<PasskeyRecord[]>;
  deletePasskey(args: { headers: Headers; body: { id: string } }): Promise<unknown>;
  updatePasskey(args: { headers: Headers; body: { id: string; name: string } }): Promise<unknown>;
}

/**
 * Die Passkey-Endpunkte einer Instanz, die mit `passkey` gebaut wurde.
 *
 * Wirft, wenn die Instanz keine hat: ein Aufruf ins Leere wäre sonst ein
 * `undefined is not a function` an der Stelle, an der sich jemand anmelden will.
 */
export function passkeyApi(auth: { api: unknown }): PasskeyApi {
  const api = auth.api as Partial<PasskeyApi>;
  if (typeof api.verifyPasskeyAuthentication !== 'function') {
    throw new Error('Diese Auth-Instanz hat keine Passkeys. `passkey` in createAuth setzen.');
  }
  return api as PasskeyApi;
}

export {
  authUsers,
  authSessions,
  authAccounts,
  authVerifications,
  authTwoFactors,
  authPasskeys,
  authUserColumns,
  authSchemaMap,
  createAuthTables,
  authTablesIn,
} from './schema';

export {
  resetPasswordMail,
  verifyEmailMail,
  changeEmailMail,
  type MailContent,
  type MailKind,
  type MailContext,
} from './mail';
