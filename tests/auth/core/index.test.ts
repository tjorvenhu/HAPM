/**
 * Zwei Zusicherungen, die man dem Ergebnis nicht ansieht.
 *
 * Bei beiden bleibt der Fehler lange unbemerkt:
 *
 *   1. `extend` darf nicht flach ersetzen. Wer sonst `emailAndPassword`
 *      ergänzt, verliert `sendResetPassword` — es geht danach keine einzige
 *      Reset-Mail mehr hinaus, und das fällt erst auf, wenn jemand sein
 *      Passwort vergisst.
 *   2. Das Ablösen alter Passwort-Hashes muss NACH erfolgreicher Prüfung
 *      schreiben und darf beim Scheitern des Schreibens trotzdem `true`
 *      liefern — das Passwort war richtig, und ein Fehlschlag beim Aufräumen
 *      darf niemanden aussperren.
 *
 * Geprüft wird deshalb die zusammengebaute Konfiguration und die reine
 * Prüffunktion, nicht ein laufender Anmeldevorgang: was hier schiefgeht, geht
 * beim Zusammenbauen schief.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  authTablesIn,
  createAuth,
  passkeyApi,
  PASSKEY_NEEDS_USER_VERIFICATION,
  type AuthOptions,
} from '@/lib/auth/core/index';

/**
 * Ein Drizzle-Doppel, das nur mitschreibt.
 *
 * `update().set().where()` ist die Kette, die `makeVerify` benutzt; mehr
 * braucht es nicht, und eine echte Datenbank für eine Zeile Bedingung wäre ein
 * Testaufbau, der öfter kaputt ist als der Code.
 */
function fakeDb() {
  const calls: { set: unknown; where: unknown }[] = [];
  let fail = false;

  return {
    calls,
    breakWrites() {
      fail = true;
    },
    update() {
      return {
        set(values: unknown) {
          return {
            where(condition: unknown) {
              if (fail) return Promise.reject(new Error('Verbindung weg'));
              calls.push({ set: values, where: condition });
              return Promise.resolve();
            },
          };
        },
      };
    },
  };
}

function baseOptions(over: Partial<AuthOptions> = {}): AuthOptions {
  return {
    db: fakeDb(),
    appName: 'Test',
    secret: 'x'.repeat(40),
    baseURL: 'https://example.test',
    resetPasswordUrl: (token) => `https://example.test/neu?token=${token}`,
    sendMail: async () => undefined,
    ...over,
  };
}

/** Better-Auth hängt die übergebenen Optionen als `options` an die Instanz. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function optionsOf(auth: unknown): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (auth as any).options;
}

describe('Vorgaben', () => {
  it('beendet alle Sitzungen beim Zurücksetzen des Passworts', () => {
    const auth = createAuth(baseOptions());
    // Ohne das läuft die Sitzung dessen weiter, wegen dem zurückgesetzt wurde.
    expect(optionsOf(auth).emailAndPassword.revokeSessionsOnPasswordReset).toBe(true);
  });

  it('lässt die Passwortprüfung in Ruhe, wenn es keinen Altbestand gibt', () => {
    const auth = createAuth(baseOptions());
    expect(optionsOf(auth).emailAndPassword.password).toBeUndefined();
  });
});

describe('extend', () => {
  it('ergänzt einen konfigurierten Block, statt ihn zu ersetzen', () => {
    const auth = createAuth(
      baseOptions({ extend: { emailAndPassword: { maxPasswordLength: 200 } } })
    );

    const block = optionsOf(auth).emailAndPassword;
    expect(block.maxPasswordLength).toBe(200);

    // Der eigentliche Punkt: das Mitgebrachte überlebt.
    expect(typeof block.sendResetPassword).toBe('function');
    expect(block.minPasswordLength).toBe(10);
    expect(block.resetPasswordTokenExpiresIn).toBe(3600);
  });

  it('lässt einen einzelnen Wert im Block überschreiben', () => {
    const auth = createAuth(
      baseOptions({ extend: { emailAndPassword: { minPasswordLength: 16 } } })
    );

    const block = optionsOf(auth).emailAndPassword;
    expect(block.minPasswordLength).toBe(16);
    expect(typeof block.sendResetPassword).toBe('function');
  });

  it('ersetzt Listen, statt sie zusammenzuhängen', () => {
    const auth = createAuth(
      baseOptions({
        trustedOrigins: ['https://alt.test'],
        extend: { trustedOrigins: ['https://neu.test'] },
      })
    );
    // `trustedOrigins: ['a']` soll `['a']` heißen und nicht „zusätzlich zu".
    expect(optionsOf(auth).trustedOrigins).toEqual(['https://neu.test']);
  });

  it('fügt unbekannte Schlüssel einfach hinzu', () => {
    const auth = createAuth(baseOptions({ extend: { appName: 'Anders' } }));
    expect(optionsOf(auth).appName).toBe('Anders');
  });
});

describe('Passwörter aus einem Vorgängersystem', () => {
  const legacy = {
    matches: (hash: string) => hash.startsWith('$argon2'),
    verify: async ({ hash, password }: { hash: string; password: string }) =>
      hash === '$argon2id$v=19$echt' && password === 'richtig',
  };

  function verifyOf(over: Partial<AuthOptions> = {}) {
    const auth = createAuth(baseOptions({ legacyPassword: legacy, ...over }));
    return optionsOf(auth).emailAndPassword.password.verify as (p: {
      hash: string;
      password: string;
    }) => Promise<boolean>;
  }

  it('erkennt ein richtiges altes Passwort und löst den Hash ab', async () => {
    const db = fakeDb();
    const verify = verifyOf({ db });

    expect(await verify({ hash: '$argon2id$v=19$echt', password: 'richtig' })).toBe(true);

    expect(db.calls).toHaveLength(1);
    const written = db.calls[0].set as { password: string };
    // Der neue Hash ist scrypt (`salz:hash` in Hex), nicht wieder Argon2.
    expect(written.password).not.toContain('$argon2');
    expect(written.password).toContain(':');
  });

  it('lehnt ein falsches Passwort ab und schreibt nichts', async () => {
    const db = fakeDb();
    const verify = verifyOf({ db });

    expect(await verify({ hash: '$argon2id$v=19$echt', password: 'falsch' })).toBe(false);
    expect(db.calls).toHaveLength(0);
  });

  it('sperrt niemanden aus, wenn das Ablösen scheitert', async () => {
    const db = fakeDb();
    db.breakWrites();
    const onLog = vi.fn();
    const verify = verifyOf({ db, onLog });

    // Das Passwort WAR richtig — ein Fehler beim Aufräumen ändert daran nichts.
    expect(await verify({ hash: '$argon2id$v=19$echt', password: 'richtig' })).toBe(true);
    expect(onLog).toHaveBeenCalledOnce();
    expect(onLog.mock.calls[0][0].level).toBe('warn');
  });

  it('schweigt ohne onLog, statt in ein fremdes Log zu schreiben', async () => {
    const db = fakeDb();
    db.breakWrites();
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const verify = verifyOf({ db });

    expect(await verify({ hash: '$argon2id$v=19$echt', password: 'richtig' })).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('lässt einen scrypt-Hash am Altbestandszweig vorbei', async () => {
    const db = fakeDb();
    const seen: string[] = [];
    const verify = verifyOf({
      db,
      legacyPassword: {
        matches: (h) => {
          seen.push(h);
          return h.startsWith('$argon2');
        },
        verify: async () => {
          throw new Error('darf für einen scrypt-Hash nie aufgerufen werden');
        },
      },
    });

    // Falsches Passwort, aber der Weg zählt: kein Wurf, kein Schreibvorgang.
    await expect(verify({ hash: 'aabb:ccdd', password: 'egal' })).resolves.toBe(false);
    expect(seen).toEqual(['aabb:ccdd']);
    expect(db.calls).toHaveLength(0);
  });
});

describe('Passkeys', () => {
  const passkey = { rpID: 'example.test' };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pluginOf = (auth: unknown): any => optionsOf(auth).plugins.find((p: { id: string }) => p.id === 'passkey');

  it('gibt es ohne die Option nicht', () => {
    const auth = createAuth(baseOptions());
    expect(optionsOf(auth).plugins).toEqual([]);
    expect(() => passkeyApi(auth)).toThrow(/keine Passkeys/);
  });

  it('bindet sie an die genannte Domain und an die Herkunft aus baseURL', () => {
    const plugin = pluginOf(createAuth(baseOptions({ passkey })));
    expect(plugin.options.rpID).toBe('example.test');
    expect(plugin.options.origin).toBe('https://example.test');
    expect(plugin.options.rpName).toBe('Test');
  });

  it('stellt die Endpunkte über passkeyApi bereit', () => {
    const api = passkeyApi(createAuth(baseOptions({ passkey })));
    for (const name of [
      'generatePasskeyRegistrationOptions',
      'verifyPasskeyRegistration',
      'generatePasskeyAuthenticationOptions',
      'verifyPasskeyAuthentication',
      'listPasskeys',
      'deletePasskey',
      'updatePasskey',
    ] as const) {
      expect(typeof api[name], name).toBe('function');
    }
  });

  /**
   * Eine Anmeldung per Passkey gilt als beide Faktoren. Das stimmt nur, wenn
   * das Gerät die Person geprüft hat. Das Plugin fragt nur „bevorzugt" danach
   * und prüft es nicht: ohne diese beiden Haken genügte es, einen
   * Sicherheitsschlüssel zu berühren.
   */
  it('verlangt beim Hinterlegen einen auffindbaren Passkey mit Bestätigung der Person', () => {
    const plugin = pluginOf(createAuth(baseOptions({ passkey })));
    expect(plugin.options.authenticatorSelection).toEqual({ residentKey: 'required', userVerification: 'required' });
  });

  it('lehnt eine Anmeldung ab, bei der das Gerät die Person nicht bestätigt hat', () => {
    const { authentication } = pluginOf(createAuth(baseOptions({ passkey }))).options;
    expect(() => authentication.afterVerification({ verification: { authenticationInfo: { userVerified: false } } })).toThrow(
      PASSKEY_NEEDS_USER_VERIFICATION
    );
    expect(() => authentication.afterVerification({ verification: { authenticationInfo: { userVerified: true } } })).not.toThrow();
  });

  it('lehnt das Hinterlegen ohne Bestätigung der Person ab', () => {
    const { registration } = pluginOf(createAuth(baseOptions({ passkey }))).options;
    expect(() => registration.afterVerification({ verification: { registrationInfo: { userVerified: false } } })).toThrow(
      PASSKEY_NEEDS_USER_VERIFICATION
    );
    expect(() => registration.afterVerification({ verification: {} })).toThrow(PASSKEY_NEEDS_USER_VERIFICATION);
    expect(() => registration.afterVerification({ verification: { registrationInfo: { userVerified: true } } })).not.toThrow();
  });

  /**
   * Wer eigene Tabellen übergibt (anderes Schema), bekäme für `passkey` sonst
   * still die Vorgabe in `public`. Der Adapter suchte die Passkeys dann an
   * einer Stelle, an der die Tabelle nicht steht, und das fiele erst auf, wenn
   * jemand einen hinterlegen will.
   */
  it('wirft, wenn eigene Tabellen ohne die Passkey-Tabelle übergeben werden', () => {
    const { passkey: _omit, ...withoutPasskey } = authTablesIn('auth');
    void _omit;
    expect(() => createAuth(baseOptions({ passkey, tables: withoutPasskey }))).toThrow(/`tables\.passkey` fehlt/);
    expect(() => createAuth(baseOptions({ passkey, tables: authTablesIn('auth') }))).not.toThrow();
  });
});
