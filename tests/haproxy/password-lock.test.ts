import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseHaproxyConfig,
  parseGlobalSettings,
  applyGlobalSettings,
  addService,
  removeService,
  replaceService,
  toCreateInput,
  readServiceInput,
  validateCreateInput,
  validateLockPassword,
  withoutLockSecret,
  supportsPasswordLock,
  usesLockPages,
  passwordLockRules,
  passAclLine,
  lockRuleFor,
  HaproxyConfigError,
  KEEP_PASSWORD,
  INHERIT_LOCK,
  LOCK_TABLE_LINE,
  LOCK_PAGE_DIR,
  LOCK_FIELD,
  type CreateServiceInput,
  type PasswordLock,
} from '@/lib/haproxy/config';
import {
  createPasswordLock,
  hashLockPassword,
  readServiceRequest,
} from '@/lib/haproxy/password-lock';
import { germanText, type Message } from '@/lib/i18n/translate';

/** Die Meldung einer Prüfung auf Deutsch, wie sie ohne Sprache herauskommt. */
const de = (message: Message | null) => (message ? germanText(message) : message);

/**
 * Die Passwortsperre.
 *
 * Dieselbe Stelle in der Datei wie die Sperre auf Admin-IPs, nur mit sieben
 * Zeilen statt einer und einer achten im Backend. Daran hängt, was diese Datei
 * festhält:
 *
 *  - Die Sperre zählt nur vollständig. Eine halbe, neu geschrieben, wäre eine
 *    ganze, und das ist eine Änderung, die niemand angefordert hat.
 *  - Alles, was sie schreibt, geht beim Lösen und beim Löschen wieder weg. Eine
 *    Regel ohne ihre ACL lässt HAProxy die ganze Datei ablehnen.
 *  - Hash und Cookie-Wert verlassen den Server nicht, und ein Eintrag lässt
 *    sich trotzdem vollständig zurückschicken.
 *
 * Ob HAProxy die Zeilen so versteht, wie sie gemeint sind, prüft
 * `scripts/verify-proxy-pages.ts` gegen ein echtes HAProxy.
 */

const CONFIG = `frontend https_in
    bind :443 ssl crt /etc/haproxy/certs/

    # Globale HTTPS-Settings
    option forwardfor

# END AUTO INTERN SERVICES

# END AUTO KUNDEN SERVICES

# ============================================================

# END AUTO INTERN BACKENDS

# END AUTO KUNDEN BACKENDS
`;

const LOCK: PasswordLock = {
  salt: '0123456789abcdef0123456789abcdef',
  hash: 'a'.repeat(64),
  token: 'b'.repeat(64),
};

const SERVICE: CreateServiceInput = {
  scope: 'KUNDEN',
  id: 'vorschau',
  domains: ['vorschau.kunde.example'],
  servers: [{ name: 'web', target: '10.10.0.4:3000', weight: null }],
  redirect: null,
  routes: [],
  balance: null,
  sticky: false,
  lockedDomains: ['vorschau.kunde.example'],
  passwordLock: LOCK,
  responseHeaders: [],
  requestHeaders: [],
  tunnel: false,
  crowdsec: false,
  healthcheck: true,
  backendTls: 'off',
};

function find(text: string, id: string) {
  return parseHaproxyConfig(text).find((s) => s.id === id)!;
}

describe('Mit Passwort sperren', () => {
  const locked = addService(CONFIG, SERVICE);

  it('schreibt Cookie-ACL, sechs Regeln und die Zählung im Backend', () => {
    const lines = locked.split('\n').map((l) => l.trim());
    expect(lines).toContain(passAclLine('vorschau', LOCK));
    for (const rule of passwordLockRules('vorschau', 'host_vorschau', LOCK)) {
      expect(lines).toContain(rule);
    }
    expect(passwordLockRules('vorschau', 'host_vorschau', LOCK)).toHaveLength(6);
    expect(lines).toContain(LOCK_TABLE_LINE);
    // Keine Regel der anderen Art daneben.
    expect(locked).not.toContain('http-request deny');
  });

  it('kommt ohne Admin-IPs aus', () => {
    // Die Datei oben hat keine. Für die Sperre auf Admin-IPs wäre das ein
    // Fehler, die Passwortsperre benutzt die Liste nicht.
    expect(parseGlobalSettings(CONFIG).adminIps).toEqual([]);
    expect(() => addService(CONFIG, { ...SERVICE, passwordLock: null })).toThrow(/keine Admin-IPs/);
  });

  it('steht vor der Weiche und die ACL vor ihrer ersten Verwendung', () => {
    const lines = locked.split('\n').map((l) => l.trim());
    const acl = lines.indexOf(passAclLine('vorschau', LOCK));
    const first = lines.findIndex((l) => l.includes('!pass_vorschau'));
    expect(acl).toBeGreaterThan(lines.indexOf('acl host_vorschau hdr(host),lower -i vorschau.kunde.example'));
    expect(acl).toBeLessThan(first);
    expect(first).toBeLessThan(lines.indexOf('use_backend vorschau if host_vorschau'));
  });

  it('liest sie vollständig zurück und bleibt bearbeitbar', () => {
    const service = find(locked, 'vorschau');
    expect(service.lockedDomains).toEqual(SERVICE.domains);
    expect(service.passwordLock).toEqual(LOCK);
    expect(service.extras).toEqual([]);
    expect(service.editable).toBe(true);
    expect(toCreateInput(service)).toEqual(SERVICE);
  });

  it('geht beim Löschen spurlos weg', () => {
    expect(removeService(locked, 'vorschau')).toBe(CONFIG);
  });

  it('geht beim Lösen weg, samt Zählung', () => {
    const offen = replaceService(locked, 'vorschau', {
      ...SERVICE,
      lockedDomains: [],
      passwordLock: null,
    });
    expect(offen).not.toContain('pass_vorschau');
    expect(offen).not.toContain('stick-table');
    expect(offen).not.toContain(LOCK_PAGE_DIR);
    expect(find(offen, 'vorschau').passwordLock).toBeNull();
  });

  it('zählt nicht als Eintrag, der an den Admin-IPs hängt', () => {
    // Sonst ließe sich die Adressliste nicht leeren, obwohl niemand sie benutzt.
    expect(parseGlobalSettings(locked).lockedServices).toEqual([]);
  });

  it('wechselt zwischen den beiden Arten, ohne Reste zu hinterlassen', () => {
    const withIps = applyGlobalSettings(locked, {
      httpsLines: ['option forwardfor'],
      adminIps: ['203.0.113.7'],
    });
    const aufIps = replaceService(withIps, 'vorschau', { ...SERVICE, passwordLock: null });
    expect(aufIps).toContain(lockRuleFor('host_vorschau'));
    expect(aufIps).not.toContain('pass_vorschau');
    expect(aufIps).not.toContain('stick-table');
    expect(find(aufIps, 'vorschau').passwordLock).toBeNull();
    expect(parseGlobalSettings(aufIps).lockedServices).toEqual(['vorschau']);

    const zurueck = replaceService(aufIps, 'vorschau', SERVICE);
    expect(zurueck).not.toContain('http-request deny');
    expect(find(zurueck, 'vorschau').passwordLock).toEqual(LOCK);
    expect(find(zurueck, 'vorschau').editable).toBe(true);
  });

  it('verträgt sich mit einer Weiterleitung', () => {
    const umleitung: CreateServiceInput = {
      ...SERVICE,
      servers: [],
      healthcheck: false,
      redirect: { to: 'https://kunde.example', keepPath: false, permanent: false },
    };
    const text = addService(CONFIG, umleitung);
    const service = find(text, 'vorschau');
    expect(service.editable).toBe(true);
    expect(toCreateInput(service)).toEqual(umleitung);
    expect(removeService(text, 'vorschau')).toBe(CONFIG);
  });

  it('verträgt sich mit Verfahren, Bindung und Pfad-Regeln', () => {
    const voll: CreateServiceInput = {
      ...SERVICE,
      servers: [
        { name: 'a', target: '10.10.0.4:3000', weight: null },
        { name: 'b', target: '10.10.0.5:3000', weight: 2 },
      ],
      balance: 'leastconn',
      sticky: true,
      routes: [
        {
          name: 'terminal',
          paths: ['/terminal'],
          servers: [{ name: 'term', target: '10.10.0.4:6002' }],
          check: true,
          backendTls: 'off',
        },
      ],
    };
    const text = addService(CONFIG, voll);
    const service = find(text, 'vorschau');
    expect(service.extras).toEqual([]);
    expect(service.editable).toBe(true);
    expect(toCreateInput(service)).toEqual(voll);
    expect(removeService(text, 'vorschau')).toBe(CONFIG);
  });
});

describe('Einzelne Domains mit Passwort sperren', () => {
  const ZWEI: CreateServiceInput = {
    ...SERVICE,
    domains: ['kunde.example', 'vorschau.kunde.example'],
    lockedDomains: ['vorschau.kunde.example'],
  };
  const teilweise = addService(CONFIG, ZWEI);

  it('hängt die Regeln an lock_<id> statt an die Host-ACL', () => {
    expect(teilweise).toContain('    acl lock_vorschau hdr(host),lower -i vorschau.kunde.example');
    for (const rule of passwordLockRules('vorschau', 'lock_vorschau', LOCK)) {
      expect(teilweise).toContain(`    ${rule}`);
    }
    // Über die Host-ACL wäre auch `kunde.example` gesperrt.
    expect(teilweise).not.toContain('host_vorschau !pass_vorschau');
  });

  it('liest genau diese Domain zurück', () => {
    const service = find(teilweise, 'vorschau');
    expect(service.lockedDomains).toEqual(['vorschau.kunde.example']);
    expect(service.passwordLock).toEqual(LOCK);
    expect(service.editable).toBe(true);
    expect(toCreateInput(service)).toEqual(ZWEI);
  });

  it('räumt beim Löschen alles ab', () => {
    expect(removeService(teilweise, 'vorschau')).toBe(CONFIG);
  });
});

describe('Die Sperre zählt nur vollständig', () => {
  const locked = addService(CONFIG, SERVICE);
  const rules = passwordLockRules('vorschau', 'host_vorschau', LOCK);

  it('ist nur lesbar, wenn eine der sechs Regeln fehlt', () => {
    // Ohne die Zählregel gäbe es beliebig viele Versuche. Neu geschrieben stünde
    // sie wieder da, und das wäre eine Änderung, nach der niemand gefragt hat.
    const ohne = locked.replace(`    ${rules[0]}\n`, '');
    const service = find(ohne, 'vorschau');
    expect(service.passwordLock).toBeNull();
    expect(service.lockedDomains).toEqual([]);
    expect(service.editable).toBe(false);
    expect(service.extras).toContain(rules[5]);
    // Löschen bleibt erlaubt und nimmt alles mit.
    expect(service.removable).toBe(true);
    expect(removeService(ohne, 'vorschau')).toBe(CONFIG);
  });

  it('ist nur lesbar, wenn jemand eine Regel von Hand geändert hat', () => {
    const geaendert = locked.replace('gt 10 }', 'gt 500 }');
    const service = find(geaendert, 'vorschau');
    expect(service.passwordLock).toBeNull();
    expect(service.editable).toBe(false);
  });

  it('ist nur lesbar, wenn die Zählung im Backend fehlt', () => {
    const ohne = locked.replace(`    ${LOCK_TABLE_LINE}\n`, '');
    const service = find(ohne, 'vorschau');
    // Gesperrt IST der Eintrag, und das soll die Karte auch sagen.
    expect(service.passwordLock).toEqual(LOCK);
    expect(service.editable).toBe(false);
    expect(service.extras.join(' ')).toContain('stick-table');
  });

  it('meldet eine Zählung ohne Sperre', () => {
    const offen = addService(CONFIG, { ...SERVICE, lockedDomains: [], passwordLock: null });
    const mit = offen.replace('backend vorschau\n', `backend vorschau\n    ${LOCK_TABLE_LINE}\n`);
    const service = find(mit, 'vorschau');
    expect(service.editable).toBe(false);
    expect(service.extras).toContain(LOCK_TABLE_LINE);
  });

  it('kennt nicht beide Arten zugleich', () => {
    const withIps = applyGlobalSettings(locked, {
      httpsLines: ['option forwardfor'],
      adminIps: ['203.0.113.7'],
    });
    const beides = withIps.replace(
      '    use_backend vorschau if host_vorschau',
      `    ${lockRuleFor('host_vorschau')}\n    use_backend vorschau if host_vorschau`
    );
    const service = find(beides, 'vorschau');
    expect(service.editable).toBe(false);
    expect(service.passwordLock).toBeNull();
  });
});

describe('Das Passwort, das schon dasteht', () => {
  const locked = addService(CONFIG, SERVICE);

  it('bleibt beim Ändern stehen', () => {
    // Der Browser kennt Hash und Cookie-Wert nicht. Er schickt den Verweis, und
    // eine geänderte Backend-Adresse darf niemanden abmelden.
    const next = replaceService(locked, 'vorschau', {
      ...SERVICE,
      servers: [{ name: 'web', target: '10.10.0.9:3000', weight: null }],
      passwordLock: KEEP_PASSWORD,
    });
    expect(find(next, 'vorschau').passwordLock).toEqual(LOCK);
    expect(next).toContain('server web 10.10.0.9:3000 check');
  });

  it('bleibt auch beim Umbenennen stehen', () => {
    const next = replaceService(locked, 'vorschau', {
      ...SERVICE,
      id: 'preview',
      passwordLock: KEEP_PASSWORD,
    });
    expect(find(next, 'preview').passwordLock).toEqual(LOCK);
    expect(next).not.toContain('pass_vorschau');
  });

  it('lässt sich nicht behalten, wenn keins da ist', () => {
    const offen = addService(CONFIG, { ...SERVICE, lockedDomains: [], passwordLock: null });
    expect(() =>
      replaceService(offen, 'vorschau', { ...SERVICE, passwordLock: KEEP_PASSWORD })
    ).toThrow(HaproxyConfigError);
    expect(() => addService(CONFIG, { ...SERVICE, passwordLock: KEEP_PASSWORD })).toThrow(
      /kein Passwort/
    );
  });

  it('bleibt stehen, wenn ein Aufrufer das Feld gar nicht kennt', () => {
    // Ein anderer Dienst ändert über /api/internal eine Backend-Adresse und
    // schickt die Felder, die er kennt. Daraus eine Sperre auf Admin-IPs zu
    // machen hieße: alle mit Passwort stehen vor einem 403.
    const body = {
      ...SERVICE,
      passwordLock: undefined,
      servers: [{ name: 'web', target: '10.10.0.9:3000' }],
    };
    const input = readServiceInput(body);
    expect(input.passwordLock).toBe(INHERIT_LOCK);
    expect(find(replaceService(locked, 'vorschau', input), 'vorschau').passwordLock).toEqual(LOCK);
  });

  it('macht daraus keine Passwortsperre, wo keine war', () => {
    // Dieselbe Eingabe auf einem Eintrag, der auf Admin-IPs gesperrt ist: er
    // bleibt es. `INHERIT_LOCK` ist keine Forderung nach einem Passwort.
    const withIps = applyGlobalSettings(CONFIG, {
      httpsLines: ['option forwardfor'],
      adminIps: ['203.0.113.7'],
    });
    const aufIps = addService(withIps, { ...SERVICE, passwordLock: null });
    const input = readServiceInput({ ...SERVICE, passwordLock: undefined });
    const next = replaceService(aufIps, 'vorschau', input);
    expect(find(next, 'vorschau').passwordLock).toBeNull();
    expect(next).toContain(lockRuleFor('host_vorschau'));
    // Und beim Anlegen gibt es nichts zu erben.
    expect(addService(withIps, input)).toContain(lockRuleFor('host_vorschau'));
  });

  it('weicht einem ausdrücklichen null', () => {
    // Die Oberfläche schickt das Feld immer. `null` heißt dort: auf Admin-IPs.
    expect(readServiceInput({ ...SERVICE, passwordLock: null }).passwordLock).toBeNull();
  });

  it('geht nicht an den Browser', () => {
    const service = withoutLockSecret(find(locked, 'vorschau'));
    expect(service.passwordLock).toBe(KEEP_PASSWORD);
    const sent = JSON.stringify(service);
    expect(sent).not.toContain(LOCK.token);
    expect(sent).not.toContain(LOCK.hash);
    expect(sent).not.toContain(LOCK.salt);
    // Und kommt als vollständige Eingabe wieder zurück.
    expect(toCreateInput(service).passwordLock).toBe(KEEP_PASSWORD);
  });

  it('lässt einen offenen Eintrag unverändert', () => {
    const offen = find(
      addService(CONFIG, { ...SERVICE, lockedDomains: [], passwordLock: null }),
      'vorschau'
    );
    expect(withoutLockSecret(offen)).toBe(offen);
  });
});

describe('Eingabe', () => {
  it('lehnt eine Sperre ohne gesperrte Domain ab', () => {
    expect(de(validateCreateInput({ ...SERVICE, lockedDomains: [] }))).toMatch(/mindestens eine gesperrte/);
  });

  it('lehnt alles ab, was nicht nach Hex aussieht', () => {
    // Die drei Werte stehen als Wörter in Zeilen einer Datei, die root lädt.
    for (const bad of [
      { ...LOCK, salt: 'x' },
      { ...LOCK, hash: `${'a'.repeat(63)} ` },
      { ...LOCK, token: `${'b'.repeat(60)}"; }` },
      { ...LOCK, hash: 'A'.repeat(64) },
    ]) {
      expect(de(validateCreateInput({ ...SERVICE, passwordLock: bad }))).toMatch(/erwartete Form/);
    }
    expect(de(validateCreateInput(SERVICE))).toBeNull();
    expect(de(validateCreateInput({ ...SERVICE, passwordLock: KEEP_PASSWORD }))).toBeNull();
  });

  it('liest aus dem Rumpf nur den Verweis, nie einen Hash', () => {
    const base = { ...SERVICE, passwordLock: undefined };
    expect(readServiceInput({ ...base, passwordLock: KEEP_PASSWORD }).passwordLock).toBe(KEEP_PASSWORD);
    expect(readServiceInput({ ...base, lockPassword: 'ein neues Passwort' }).passwordLock).toBe(
      KEEP_PASSWORD
    );
    // Ein mitgeschickter Hash wird nicht übernommen: er hieße, dass ein
    // Aufrufer den Cookie-Wert selbst bestimmt.
    expect(readServiceInput({ ...base, passwordLock: LOCK }).passwordLock).toBeNull();
    // Ohne jede Angabe bleibt die Art, wie sie ist (siehe weiter oben).
    expect(readServiceInput(base).passwordLock).toBe(INHERIT_LOCK);
    // Ohne gesperrte Domain gibt es nichts zu sperren.
    expect(
      readServiceInput({ ...base, lockedDomains: [], lockPassword: 'ein neues Passwort' }).passwordLock
    ).toBeNull();
  });

  it('prüft das Passwort', () => {
    expect(de(validateLockPassword('kurz'))).toMatch(/mindestens 8/);
    expect(de(validateLockPassword('x'.repeat(129)))).toMatch(/höchstens 128/);
    expect(de(validateLockPassword('mit\tTabulator'))).toMatch(/Steuerzeichen/);
    expect(de(validateLockPassword('a b+c%&=ä"\'<>€;'))).toBeNull();
  });
});

describe('Aus dem Passwort wird die Sperre', () => {
  it('hasht so, wie HAProxy nachrechnet: Passwort, dann Salz', () => {
    // …,url_dec(1),concat(<salz>),sha2(256),hex,lower
    const expected = createHash('sha256').update(`geheim!${LOCK.salt}`, 'utf8').digest('hex');
    expect(hashLockPassword('geheim!', LOCK.salt)).toBe(expected);
  });

  it('hasht zerlegte und zusammengesetzte Umlaute gleich', () => {
    expect(hashLockPassword('Bärenhöhle', LOCK.salt)).toBe(
      hashLockPassword('Bärenhöhle', LOCK.salt)
    );
  });

  it('erzeugt je Aufruf ein eigenes Salz und einen eigenen Cookie-Wert', () => {
    const a = createPasswordLock('dasselbe Passwort');
    const b = createPasswordLock('dasselbe Passwort');
    expect(de(validateCreateInput({ ...SERVICE, passwordLock: a }))).toBeNull();
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toBe(hashLockPassword('dasselbe Passwort', a.salt));
  });

  it('setzt ein mitgeschicktes Passwort ein und lässt das Passwort selbst weg', () => {
    const input = readServiceRequest({ ...SERVICE, passwordLock: undefined, lockPassword: 'ein neues Passwort' });
    expect(input.passwordLock).not.toBe(KEEP_PASSWORD);
    expect(de(validateCreateInput(input))).toBeNull();
    expect(JSON.stringify(input)).not.toContain('ein neues Passwort');
    // Und die Datei, die daraus entsteht, trägt es auch nicht.
    expect(addService(CONFIG, input)).not.toContain('ein neues Passwort');
  });

  it('lässt den Verweis stehen, wenn kein Passwort mitkam', () => {
    expect(readServiceRequest({ ...SERVICE, passwordLock: KEEP_PASSWORD }).passwordLock).toBe(
      KEEP_PASSWORD
    );
  });

  it('lehnt ein zu kurzes Passwort ab', () => {
    expect(() =>
      readServiceRequest({ ...SERVICE, passwordLock: undefined, lockPassword: 'kurz' })
    ).toThrow(/mindestens 8/);
  });
});

describe('Die Routen', () => {
  const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

  /* Gelesen und nicht aufgerufen: die Routen hängen an Sitzung, Datenbank
   * und einem laufenden HAProxy. Was hier feststeht, ist die
   * eine Zeile, die niemand beim nächsten Umbau vergessen darf. */

  it('geben Hash und Cookie-Wert nicht an den Browser', () => {
    expect(source('app/api/haproxy/services/route.ts')).toContain(
      'services: probe.services.map(withoutLockSecret)'
    );
  });

  it('geben über /api/internal nur die Art der Sperre heraus', () => {
    const view = source('lib/haproxy/internal.ts');
    expect(view).toContain('lockMode:');
    expect(view).not.toMatch(/passwordLock:\s*service\.passwordLock/);
  });

  it('lesen den Dienst alle über dieselbe Stelle, samt Passwort', () => {
    // Eine Route, die `readServiceInput` direkt nähme, ließe ein mitgeschicktes
    // Passwort fallen: aus „mit Passwort sperren" würde ein Fehler oder, beim
    // Ändern, das alte Passwort.
    // Die Routen unter /api/internal und der MCP-Server lesen über
    // `lib/haproxy/api-actions.ts`, die beiden Funktionen dort zählen wie Routen.
    for (const route of [
      'app/api/haproxy/services/route.ts',
      'app/api/haproxy/services/[id]/route.ts',
      'lib/haproxy/api-actions.ts',
    ]) {
      const text = source(route);
      expect(text, route).toContain('readServiceRequest(body)');
      expect(text, route).not.toContain('readServiceInput');
    }
    const actions = source('lib/haproxy/api-actions.ts');
    expect(actions.match(/readServiceRequest\(body\)/g)).toHaveLength(2);
    expect(source('app/api/internal/haproxy/services/route.ts')).toContain('createServiceRun(');
    expect(source('app/api/internal/haproxy/services/[id]/route.ts')).toContain('updateServiceRun(');
    expect(source('lib/mcp/tools.ts')).not.toContain('readServiceInput');
  });
});

describe('Was die Maschine dafür können und haben muss', () => {
  it('kennt die Grenze bei HAProxy 2.4', () => {
    expect(supportsPasswordLock('2.2.9-2+deb11u6')).toBe(false);
    expect(supportsPasswordLock('1.8.27')).toBe(false);
    expect(supportsPasswordLock('2.4.0')).toBe(true);
    expect(supportsPasswordLock('2.8.5-1ubuntu3')).toBe(true);
    expect(supportsPasswordLock('3.0.3')).toBe(true);
    // Unbekannt ist nicht „geht nicht": dann entscheidet `haproxy -c`.
    expect(supportsPasswordLock(null)).toBeNull();
    expect(supportsPasswordLock('unbekannt')).toBeNull();
  });

  it('erkennt, ob eine Konfiguration die Seiten der Abfrage braucht', () => {
    expect(usesLockPages(CONFIG)).toBe(false);
    expect(usesLockPages(addService(CONFIG, SERVICE))).toBe(true);
  });

  it('nennt in den Regeln das Feld, das die Seite schickt', () => {
    expect(passwordLockRules('vorschau', 'host_vorschau', LOCK)[3]).toContain(
      `req.body_param(${LOCK_FIELD})`
    );
  });
});
