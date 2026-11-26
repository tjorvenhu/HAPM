import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DNS_PROVIDERS,
  findDnsProvider,
  validateDnsCredentials,
  credentialFiles,
  credentialLines,
  credentialNamesToClear,
  plainNamesToClear,
  writeCredentialFileCommand,
  removeCredentialFileCommand,
  writeCredentialsCommand,
  zoneAccess,
  INFOBLOX_CA_FILE,
  NSUPDATE_KEY_FILE,
  TRUST_SYNC,
} from '@/lib/haproxy/dns-credentials';
import { readInfobloxAccess, readRfc2136Access } from '@/lib/dns/access';
import { DNS_HOOK_PROBE } from '@/lib/haproxy/provision';
import { parseDnsHooks } from '@/lib/haproxy/certs';

/**
 * Das Ablegen der DNS-Zugangsdaten, von einer echten Bash nachgerechnet.
 *
 * Der Befehl fasst die Datei an, in der acme.sh **alle** seine Zugangsdaten
 * hält. Drei Dinge können daran kaputtgehen, und zwei davon still:
 *
 *  - Die Datei leer zurücklassen. `grep -v` meldet 1, wenn keine Zeile übrig
 *    bleibt; unter `set -e` bräche der Vorgang ab, mit einem blinden `|| true`
 *    stünde bei einem echten Fehler eine leere `account.conf` da — und damit
 *    wäre jede andere Zugangsdatum weg.
 *  - Die Rechte verlieren. `account.conf` steht auf 600. Ein `mv` einer frisch
 *    angelegten Datei darüber machte 644 daraus, mit einem API-Token darin.
 *  - Fremde Zeilen mitnehmen. Gefiltert wird auf `SAVED_<name>=`, und ein zu
 *    weites Muster nähme die Zugangsdaten eines anderen Anbieters mit.
 */

let dir: string | null = null;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/**
 * Der Pfad, wie ihn die Bash liest. Unter Windows liefert `mkdtemp` einen Pfad
 * mit Backslashes, und die sind für die Shell Escapes. Git Bash versteht
 * `C:/Users/…`. Betrifft nur den Test: auf der Gegenstelle steht ein
 * Linux-Pfad. Dieselbe Umformung wie in `prune.test.ts`.
 */
function posix(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * Der Befehl zeigt fest auf `/root/.acme.sh/account.conf`. Für den Test wird
 * genau diese eine Zeile auf ein Temp-Verzeichnis umgebogen — alles andere,
 * insbesondere das Filtern und das Zurückschreiben, läuft unverändert.
 */
function scriptFor(names: string[], conf: string, plainNames: string[] = []): string {
  return writeCredentialsCommand(names, plainNames).replace(
    'conf=/root/.acme.sh/account.conf',
    `conf='${posix(conf)}'`
  );
}

function runAgainst(content: string, names: string[], stdin: string) {
  dir = mkdtempSync(join(tmpdir(), 'acme-'));
  const conf = join(dir, 'account.conf');
  writeFileSync(conf, content, { mode: 0o600 });

  execFileSync('bash', ['-c', scriptFor(names, conf)], { input: stdin });
  return { conf, text: readFileSync(conf, 'utf8'), mode: statSync(conf).mode & 0o777 };
}

/** Wie `runAgainst`, mit den Variablen, die ein Hook ohne `SAVED_` führt. */
function runAgainstPlain(content: string, names: string[], plainNames: string[], stdin: string) {
  dir = mkdtempSync(join(tmpdir(), 'acme-'));
  const conf = join(dir, 'account.conf');
  writeFileSync(conf, content, { mode: 0o600 });

  execFileSync('bash', ['-c', scriptFor(names, conf, plainNames)], { input: stdin });
  return { conf, text: readFileSync(conf, 'utf8') };
}

const EXISTING = [
  "ACCOUNT_EMAIL='ops@example.org'",
  "SAVED_CF_Token='alterwert'",
  "SAVED_HETZNER_TOKEN='fremderanbieter'",
  'UPGRADE_HASH=abc',
  '',
].join('\n');

describe('writeCredentialsCommand', () => {
  it('ersetzt den eigenen Wert und lässt alles andere stehen', () => {
    const { text } = runAgainst(EXISTING, ['CF_Token', 'CF_Account_ID'], "SAVED_CF_Token='neu'\n");

    expect(text).toContain("SAVED_CF_Token='neu'");
    expect(text).not.toContain('alterwert');
    // Der andere Anbieter und die übrigen Zeilen bleiben unangetastet.
    expect(text).toContain("SAVED_HETZNER_TOKEN='fremderanbieter'");
    expect(text).toContain("ACCOUNT_EMAIL='ops@example.org'");
    expect(text).toContain('UPGRADE_HASH=abc');
  });

  it('entfernt bei leerem stdin nur die eigenen Zeilen', () => {
    const { text } = runAgainst(EXISTING, ['CF_Token', 'CF_Account_ID'], '');

    expect(text).not.toContain('SAVED_CF_Token');
    expect(text).toContain("SAVED_HETZNER_TOKEN='fremderanbieter'");
    expect(text).toContain("ACCOUNT_EMAIL='ops@example.org'");
  });

  it('schreibt IN die Datei und schiebt keine neue darüber', () => {
    /* Der Zielinode bleibt derselbe, also Besitzer, Rechte und Kontext —
     * dieselbe Überlegung wie beim `cp` auf `haproxy.cfg`. Geprüft wird der
     * Inode und nicht der Modus: unter Windows meldet Node für jede
     * beschreibbare Datei 0o666, die Rechte wären dort also kein Beweis. Der
     * Inode ist der Mechanismus dahinter und auf beiden Systemen zu haben. */
    dir = mkdtempSync(join(tmpdir(), 'acme-'));
    const conf = join(dir, 'account.conf');
    writeFileSync(conf, EXISTING, { mode: 0o600 });
    const before = statSync(conf).ino;

    execFileSync('bash', ['-c', scriptFor(['CF_Token'], conf)], {
      input: "SAVED_CF_Token='neu'\n",
    });

    expect(statSync(conf).ino).toBe(before);
    expect(readFileSync(conf, 'utf8')).toContain("SAVED_CF_Token='neu'");
  });

  it('läuft auch, wenn die Datei NUR aus den gefilterten Zeilen besteht', () => {
    // Der Fall, in dem `grep -v` mit 1 endet. Unter `set -e` bräche der Vorgang
    // hier ab, und der Token käme nie an.
    const { text } = runAgainst("SAVED_CF_Token='alt'\n", ['CF_Token'], "SAVED_CF_Token='neu'\n");
    expect(text.trim()).toBe("SAVED_CF_Token='neu'");
  });

  it('nimmt keine Zeile mit, die nur ähnlich heißt', () => {
    const { text } = runAgainst(
      ["SAVED_CF_Token='alt'", "SAVED_CF_Token_Backup='bleibt'", ''].join('\n'),
      ['CF_Token'],
      "SAVED_CF_Token='neu'\n"
    );
    expect(text).toContain("SAVED_CF_Token_Backup='bleibt'");
  });

  it('scheitert erkennbar, wenn es keine acme.sh-Konfiguration gibt', () => {
    // Eine `account.conf` anzulegen wäre eine halbe Installation — die macht
    // dieses Werkzeug nicht, und der Exit-Code sagt es.
    dir = mkdtempSync(join(tmpdir(), 'acme-'));
    const script = scriptFor(['CF_Token'], join(dir, 'account.conf'));
    let code: number | null = null;
    try {
      execFileSync('bash', ['-c', script], { input: '', stdio: 'pipe' });
    } catch (err) {
      code = (err as { status: number }).status;
    }
    expect(code).toBe(3);
  });

  it('lässt keinen Variablennamen durch, der kein Variablenname ist', () => {
    // Der Name geht in einen regulären Ausdruck im Kommando. Er kommt aus der
    // Allow-Liste, geprüft wird er trotzdem.
    expect(() => writeCredentialsCommand(['CF_Token|.*'])).toThrow();
    expect(() => writeCredentialsCommand(['CF Token'])).toThrow();
  });
});

describe('validateDnsCredentials', () => {
  const cf = { hook: 'dns_cf', values: { CF_Token: 'abc123' }, remove: false };

  it('nimmt einen gewöhnlichen Token', () => {
    expect(validateDnsCredentials(cf)).toBeNull();
  });

  it('lehnt einen Wert ab, der die Datei bräche', () => {
    // acme.sh legt Werte als KEY='wert' ab; ein Apostroph darin macht aus der
    // Datei etwas, das beim nächsten Lauf jede andere Zugangsdatum mitnimmt.
    for (const bad of ["ab'c", 'ab c', 'ab$c', 'ab\\c', 'ab"c']) {
      expect(validateDnsCredentials({ ...cf, values: { CF_Token: bad } })).not.toBeNull();
    }
  });

  it('verlangt das Pflichtfeld — außer beim Entfernen', () => {
    expect(validateDnsCredentials({ ...cf, values: { CF_Token: '' } })).not.toBeNull();
    expect(validateDnsCredentials({ ...cf, values: { CF_Token: '' }, remove: true })).toBeNull();
  });

  it('lehnt ein Feld ab, das dem Anbieter nicht gehört', () => {
    expect(
      validateDnsCredentials({ ...cf, values: { CF_Token: 'abc', HETZNER_TOKEN: 'x' } })
    ).not.toBeNull();
  });

  it('kennt nur Anbieter aus der Allow-Liste', () => {
    expect(validateDnsCredentials({ hook: 'dns_erfunden', values: {}, remove: false })).not.toBeNull();
    expect(findDnsProvider('dns_erfunden')).toBeNull();
  });
});

describe('credentialLines', () => {
  it('schreibt SAVED_ davor — sonst liest acme.sh den Wert nie', () => {
    expect(
      credentialLines({ hook: 'dns_cf', values: { CF_Token: 'abc' }, remove: false })
    ).toEqual(["SAVED_CF_Token='abc'"]);
  });

  it('lässt leere optionale Felder weg', () => {
    expect(
      credentialLines({
        hook: 'dns_cf',
        values: { CF_Token: 'abc', CF_Account_ID: '' },
        remove: false,
      })
    ).toEqual(["SAVED_CF_Token='abc'"]);
  });
});

describe('DNS_PROVIDERS', () => {
  it('trägt je Anbieter mindestens ein Pflichtfeld', () => {
    // Ein Anbieter ohne Pflichtfeld wäre einer, den man „speichern" kann, ohne
    // etwas einzurichten.
    for (const provider of DNS_PROVIDERS) {
      expect(provider.fields.some((field) => field.required)).toBe(true);
    }
  });

  it('benennt jedes Feld so, wie acme.sh die Variable liest', () => {
    for (const provider of DNS_PROVIDERS) {
      for (const field of provider.fields) {
        expect(field.name).toMatch(/^[A-Za-z0-9_]+$/);
      }
    }
  });
});

/**
 * Schreiben, Erkennen und Ausstellen müssen denselben Namen meinen.
 *
 * Geschrieben wird `SAVED_<Feld>`, erkannt wird der Hook, dessen Skript dieses
 * Feld liest, und ausgestellt wird mit `--dns <hook>`. Steht ein Anbieter hier
 * mit einem Hook, den acme.sh nicht (mehr) mitbringt, oder mit einer Variable
 * in anderer Schreibweise, dann speichert das Formular scheinbar erfolgreich,
 * und kein Hook gilt als eingerichtet.
 *
 * Die beiden Skripte unten sind die Zeilen, mit denen das mitgelieferte acme.sh
 * (3.1.x) seine Variablen liest: `dnsapi/dns_hetznercloud.sh` und
 * `dnsapi/dns_cf.sh`. Ändert acme.sh sie, ändert sich diese Fixture mit.
 */
describe('Schreiben und Erkennen passen zusammen', () => {
  const HOOK_SCRIPTS: Record<string, string> = {
    'dns_hetznercloud.sh': [
      'HETZNER_TOKEN="${HETZNER_TOKEN:-$(_readaccountconf_mutable HETZNER_TOKEN)}"',
      'HETZNER_API="${HETZNER_API:-$(_readaccountconf_mutable HETZNER_API)}"',
      'HETZNER_TTL="${HETZNER_TTL:-$(_readaccountconf_mutable HETZNER_TTL)}"',
      'HETZNER_MAX_ATTEMPTS="${HETZNER_MAX_ATTEMPTS:-$(_readaccountconf_mutable HETZNER_MAX_ATTEMPTS)}"',
      '',
    ].join('\n'),
    'dns_cf.sh': [
      'CF_Token="${CF_Token:-$(_readaccountconf_mutable CF_Token)}"',
      'CF_Account_ID="${CF_Account_ID:-$(_readaccountconf_mutable CF_Account_ID)}"',
      '',
    ].join('\n'),
    // `dns_nsupdate` liest über `_readaccountconf_mutable`, also `SAVED_*`.
    'dns_nsupdate.sh': [
      'NSUPDATE_SERVER="${NSUPDATE_SERVER:-$(_readaccountconf_mutable NSUPDATE_SERVER)}"',
      'NSUPDATE_SERVER_PORT="${NSUPDATE_SERVER_PORT:-$(_readaccountconf_mutable NSUPDATE_SERVER_PORT)}"',
      'NSUPDATE_KEY="${NSUPDATE_KEY:-$(_readaccountconf_mutable NSUPDATE_KEY)}"',
      'NSUPDATE_ZONE="${NSUPDATE_ZONE:-$(_readaccountconf_mutable NSUPDATE_ZONE)}"',
      '',
    ].join('\n'),
    // `dns_infoblox` liest die Variablen direkt und legt sie ohne `SAVED_` ab.
    'dns_infoblox.sh': [
      'if [ -z "$Infoblox_Creds" ] || [ -z "$Infoblox_Server" ]; then return 1; fi',
      '_saveaccountconf Infoblox_Creds "$Infoblox_Creds"',
      '_saveaccountconf Infoblox_Server "$Infoblox_Server"',
      '_saveaccountconf Infoblox_View "$Infoblox_View"',
      '',
    ].join('\n'),
    // Ein fremder Hook, der zu keinem Anbieter der Liste gehört.
    'dns_other.sh': 'OTHER_Key="${OTHER_Key:-$(_readaccountconf_mutable OTHER_Key)}"\n',
  };

  function acmeHome(conf: string): string {
    dir = mkdtempSync(join(tmpdir(), 'acme-'));
    mkdirSync(join(dir, 'dnsapi'));
    for (const [name, text] of Object.entries(HOOK_SCRIPTS)) {
      writeFileSync(join(dir, 'dnsapi', name), text);
    }
    writeFileSync(join(dir, 'account.conf'), conf, { mode: 0o600 });
    return dir;
  }

  function detectedHooks(home: string): string[] {
    const probe = DNS_HOOK_PROBE.replace(
      'conf=/root/.acme.sh/account.conf; dir=/root/.acme.sh/dnsapi',
      `conf='${posix(join(home, 'account.conf'))}'; dir='${posix(join(home, 'dnsapi'))}'`
    );
    return parseDnsHooks(execFileSync('bash', ['-c', probe]).toString());
  }

  function write(home: string, hook: string, values: Record<string, string>, remove: boolean) {
    const provider = findDnsProvider(hook)!;
    const lines = credentialLines({ hook, values, remove });
    execFileSync(
      'bash',
      [
        '-c',
        scriptFor(credentialNamesToClear(provider, remove), join(home, 'account.conf'), plainNamesToClear(provider)),
      ],
      { input: remove ? '' : `${lines.join('\n')}\n` }
    );
  }

  it.each(DNS_PROVIDERS.map((provider) => provider.hook))('%s wird nach dem Speichern erkannt', (hook) => {
    const provider = findDnsProvider(hook)!;
    const home = acmeHome("ACCOUNT_EMAIL='ops@example.org'\n");
    expect(detectedHooks(home)).toEqual([]);

    const values = Object.fromEntries(
      provider.fields.filter((field) => field.required).map((field) => [field.name, 'abc123'])
    );
    write(home, hook, values, false);

    expect(detectedHooks(home)).toEqual([hook]);
  });

  it('kennt Hetzner unter dem Hook, den acme.sh mitbringt', () => {
    // `dns_hetzner` (die frühere DNS-Konsole) gibt es in acme.sh nicht mehr.
    expect(findDnsProvider('dns_hetzner')).toBeNull();
    expect(findDnsProvider('dns_hetznercloud')?.fields.map((field) => field.name)).toEqual(['HETZNER_TOKEN']);
  });

  it('entfernt auch, was der Hook selbst daneben abgelegt hat', () => {
    // Nach dem ersten Antrag stehen API-Adresse, TTL und Versuche als SAVED_* in
    // der Datei. Blieben sie stehen, gälte der Hook ohne Token weiter als eingerichtet.
    const home = acmeHome(
      [
        "SAVED_HETZNER_TOKEN='abc123'",
        "SAVED_HETZNER_API='https://api.hetzner.cloud/v1'",
        "SAVED_HETZNER_TTL='120'",
        "SAVED_HETZNER_MAX_ATTEMPTS='120'",
        "SAVED_OTHER_Key='bleibt'",
        '',
      ].join('\n')
    );
    expect(detectedHooks(home)).toEqual(['dns_hetznercloud', 'dns_other']);

    write(home, 'dns_hetznercloud', { HETZNER_TOKEN: '' }, true);

    expect(detectedHooks(home)).toEqual(['dns_other']);
    expect(readFileSync(join(home, 'account.conf'), 'utf8')).toContain("SAVED_OTHER_Key='bleibt'");
  });

  it('lässt beim Setzen stehen, was der Hook daneben führt', () => {
    const home = acmeHome("SAVED_HETZNER_TOKEN='alt'\nSAVED_HETZNER_TTL='300'\n");
    write(home, 'dns_hetznercloud', { HETZNER_TOKEN: 'neu' }, false);

    const text = readFileSync(join(home, 'account.conf'), 'utf8');
    expect(text).toContain("SAVED_HETZNER_TOKEN='neu'");
    expect(text).not.toContain("'alt'");
    expect(text).toContain("SAVED_HETZNER_TTL='300'");
  });
});

/**
 * RFC 2136 und Infoblox: Anbieter, deren Zugang mehr ist als eine
 * `SAVED_`-Zeile je Feld. Was aus dem Formular wird, steht in `build`, und hier
 * rechnet eine echte Bash nach, dass acme.sh es so liest.
 */
const SECRET = 'c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LTEyMzQ=';

const NSUPDATE = {
  hook: 'dns_nsupdate',
  values: {
    NSUPDATE_SERVER: 'NS1.example.org',
    NSUPDATE_SERVER_PORT: '',
    TSIG_NAME: 'hapm-key',
    TSIG_ALGORITHM: '',
    TSIG_SECRET: SECRET,
  },
  remove: false,
};

const PEM = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ0Fh\n-----END CERTIFICATE-----';

const INFOBLOX = {
  hook: 'dns_infoblox',
  values: {
    Infoblox_Server: 'infoblox.example.org',
    Infoblox_User: 'hapm',
    // Jedes Zeichen, das in einer Shell etwas bedeutet und trotzdem erlaubt ist.
    Infoblox_Password: 'p@ss"w$rd&|;`#%(x)',
    Infoblox_View: '',
    Infoblox_WAPI: '',
    Infoblox_CA: '',
  },
  remove: false,
};

describe('RFC 2136 (dns_nsupdate)', () => {
  it('schreibt Server, Port und den Pfad der Schlüsseldatei, nicht das Geheimnis', () => {
    expect(validateDnsCredentials(NSUPDATE)).toBeNull();
    const lines = credentialLines(NSUPDATE);
    expect(lines).toEqual([
      "SAVED_NSUPDATE_SERVER='ns1.example.org'",
      "SAVED_NSUPDATE_SERVER_PORT='53'",
      `SAVED_NSUPDATE_KEY='${NSUPDATE_KEY_FILE}'`,
    ]);
    expect(lines.join('\n')).not.toContain(SECRET);
  });

  it('legt den Schlüssel als Datei in der Form ab, die nsupdate -k liest', () => {
    expect(credentialFiles(NSUPDATE)).toEqual([
      {
        path: NSUPDATE_KEY_FILE,
        content: `key "hapm-key" {\n\talgorithm hmac-sha256;\n\tsecret "${SECRET}";\n};\n`,
      },
    ]);
    const other = { ...NSUPDATE, values: { ...NSUPDATE.values, TSIG_ALGORITHM: 'hmac-sha512' } };
    expect(credentialFiles(other)[0].content).toContain('algorithm hmac-sha512;');
  });

  it('nimmt beim Setzen eine liegengebliebene Zone mit: acme.sh kennt nur eine je Installation', () => {
    const provider = findDnsProvider('dns_nsupdate')!;
    const { text } = runAgainstPlain(
      ["SAVED_NSUPDATE_ZONE='alt.example'", "SAVED_NSUPDATE_SERVER='alt'", "SAVED_CF_Token='bleibt'", ''].join('\n'),
      credentialNamesToClear(provider, false),
      plainNamesToClear(provider),
      `${credentialLines(NSUPDATE).join('\n')}\n`
    );
    expect(text).not.toContain('NSUPDATE_ZONE');
    expect(text).not.toContain("'alt'");
    expect(text).toContain("SAVED_NSUPDATE_SERVER='ns1.example.org'");
    expect(text).toContain("SAVED_CF_Token='bleibt'");
  });

  it('lehnt ab, was in account.conf, im Heredoc von nsupdate oder in der Schlüsseldatei etwas anrichtete', () => {
    const bad: Record<string, string>[] = [
      { NSUPDATE_SERVER: "ns1'; rm -r x; '" },
      { NSUPDATE_SERVER: 'ns1 example' },
      { NSUPDATE_SERVER: 'ns1\nsend' },
      { NSUPDATE_SERVER_PORT: '70000' },
      { NSUPDATE_SERVER_PORT: '53;' },
      { TSIG_NAME: 'key"; algorithm x' },
      { TSIG_NAME: 'mit leerzeichen' },
      { TSIG_ALGORITHM: 'hmac-md5' },
      { TSIG_SECRET: 'kein base64!' },
      { TSIG_SECRET: 'a2V5"; };' },
      { TSIG_SECRET: 'YWJj' },
    ];
    for (const patch of bad) {
      expect(validateDnsCredentials({ ...NSUPDATE, values: { ...NSUPDATE.values, ...patch } }), JSON.stringify(patch)).not.toBeNull();
    }
    expect(validateDnsCredentials({ ...NSUPDATE, values: { ...NSUPDATE.values, NSUPDATE_SERVER: '2001:db8::53' } })).toBeNull();
    expect(validateDnsCredentials({ ...NSUPDATE, values: { ...NSUPDATE.values, TSIG_SECRET: '' } })).not.toBeNull();
    expect(validateDnsCredentials({ ...NSUPDATE, values: {}, remove: true })).toBeNull();
  });

  it('baut für den Bereich „DNS" denselben Zugang als Text', () => {
    const access = readRfc2136Access(zoneAccess(findDnsProvider('dns_nsupdate')!, NSUPDATE.values));
    expect(access).toEqual({ server: 'ns1.example.org', port: 53, keyName: 'hapm-key', algorithm: 'hmac-sha256', secret: SECRET });
  });

  it('nimmt beim Entfernen Zeilen und Schlüsseldatei mit', () => {
    const removal = { ...NSUPDATE, remove: true };
    expect(credentialLines(removal)).toEqual([]);
    expect(credentialFiles(removal)).toEqual([{ path: NSUPDATE_KEY_FILE, content: null }]);
    expect(credentialNamesToClear(findDnsProvider('dns_nsupdate')!, true)).toEqual(
      expect.arrayContaining(['NSUPDATE_SERVER', 'NSUPDATE_SERVER_PORT', 'NSUPDATE_KEY', 'NSUPDATE_ZONE', 'NSUPDATE_OPT'])
    );
  });
});

describe('Infoblox (dns_infoblox)', () => {
  it('schreibt die Variablen ohne SAVED_, wie der Hook sie liest, und den Namen der Appliance als Kennzeichen', () => {
    expect(validateDnsCredentials(INFOBLOX)).toBeNull();
    expect(credentialLines(INFOBLOX)).toEqual([
      `Infoblox_Creds='hapm:${INFOBLOX.values.Infoblox_Password}'`,
      "Infoblox_Server='infoblox.example.org'",
      // Immer geschrieben: beim Entfernen des TXT-Eintrags setzt der Hook keine Vorgabe ein.
      "Infoblox_View='default'",
      "SAVED_Infoblox_Server='infoblox.example.org'",
    ]);
  });

  it('kommt mit jedem erlaubten Zeichen im Passwort unverändert bei der Shell an', () => {
    const provider = findDnsProvider('dns_infoblox')!;
    const { conf } = runAgainstPlain(
      "ACCOUNT_EMAIL='ops@example.org'\n",
      credentialNamesToClear(provider, false),
      plainNamesToClear(provider),
      `${credentialLines(INFOBLOX).join('\n')}\n`
    );
    // So liest acme.sh die Datei: als Shell-Skript.
    const read = execFileSync('bash', ['-c', `. '${posix(conf)}'; printf '%s' "$Infoblox_Creds"`]).toString();
    expect(read).toBe(`hapm:${INFOBLOX.values.Infoblox_Password}`);
  });

  it('ersetzt beim Setzen die Zeilen des Hooks und lässt fremde stehen', () => {
    const provider = findDnsProvider('dns_infoblox')!;
    const { text } = runAgainstPlain(
      ["Infoblox_Creds='alt:alt'", "Infoblox_View='Alt'", "Infoblox_Server='alt'", "Infoblox_Creds_Backup='bleibt'", "CA_BUNDLE='/x.pem'", ''].join('\n'),
      credentialNamesToClear(provider, false),
      plainNamesToClear(provider),
      `${credentialLines(INFOBLOX).join('\n')}\n`
    );
    expect(text).not.toContain('alt:alt');
    expect(text).not.toContain("'Alt'");
    expect(text).toContain("Infoblox_Creds_Backup='bleibt'");
    // Ein von Hand gesetztes CA_BUNDLE gehört nicht HAPM.
    expect(text).toContain("CA_BUNDLE='/x.pem'");
  });

  it('lässt beim Entfernen nichts vom Hook zurück', () => {
    const provider = findDnsProvider('dns_infoblox')!;
    const { text } = runAgainstPlain(
      [...credentialLines(INFOBLOX), "SAVED_CF_Token='bleibt'", ''].join('\n'),
      credentialNamesToClear(provider, true),
      plainNamesToClear(provider),
      ''
    );
    expect(text).not.toContain('Infoblox');
    expect(text).toContain("SAVED_CF_Token='bleibt'");
    expect(credentialFiles({ ...INFOBLOX, remove: true })).toEqual([{ path: INFOBLOX_CA_FILE, content: null }]);
  });

  it('legt eine eigene Zertifizierungsstelle als Datei ab und räumt sie ohne Eingabe weg', () => {
    const withCa = { ...INFOBLOX, values: { ...INFOBLOX.values, Infoblox_CA: `  ${PEM}\r\n` } };
    expect(validateDnsCredentials(withCa)).toBeNull();
    expect(credentialFiles(withCa)).toEqual([{ path: INFOBLOX_CA_FILE, content: `${PEM}\n` }]);
    expect(credentialFiles(INFOBLOX)).toEqual([{ path: INFOBLOX_CA_FILE, content: null }]);
  });

  it('lehnt ab, was in account.conf oder in der URL für curl etwas anrichtete', () => {
    const bad: Record<string, string>[] = [
      { Infoblox_Server: 'https://infoblox.example.org' },
      { Infoblox_Server: 'infoblox.example.org/wapi' },
      { Infoblox_Server: "x'; id; '" },
      { Infoblox_User: 'ha:pm' },
      { Infoblox_User: 'DOMAIN\\hapm' },
      { Infoblox_Password: "mit'apostroph" },
      { Infoblox_Password: 'mit\\backslash' },
      { Infoblox_Password: 'mit leerzeichen' },
      { Infoblox_Password: 'umläut' },
      { Infoblox_View: "x'y" },
      { Infoblox_WAPI: 'neueste' },
      { Infoblox_CA: 'kein pem' },
      { Infoblox_CA: `${PEM}\n-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----` },
    ];
    for (const patch of bad) {
      expect(validateDnsCredentials({ ...INFOBLOX, values: { ...INFOBLOX.values, ...patch } }), JSON.stringify(patch)).not.toBeNull();
    }
    expect(validateDnsCredentials({ ...INFOBLOX, values: { ...INFOBLOX.values, Infoblox_View: 'Interne Sicht' } })).toBeNull();
    expect(validateDnsCredentials({ ...INFOBLOX, values: { ...INFOBLOX.values, Infoblox_Server: 'infoblox.example.org:8443' } })).toBeNull();
  });

  it('baut für den Bereich „DNS" denselben Zugang als Text', () => {
    const access = readInfobloxAccess(zoneAccess(findDnsProvider('dns_infoblox')!, { ...INFOBLOX.values, Infoblox_WAPI: 'v2.12' }));
    expect(access).toEqual({
      server: 'infoblox.example.org',
      username: 'hapm',
      password: INFOBLOX.values.Infoblox_Password,
      view: 'default',
      wapiVersion: '2.12',
      ca: null,
    });
  });
});

describe('Dateien neben account.conf', () => {
  /** Der Pfad im Kommando zeigt fest auf den Ordner von acme.sh und wird für den Test umgebogen. */
  function fileScript(command: string, home: string): string {
    return command.replaceAll('/root/.acme.sh', posix(home));
  }

  it('legt die Datei mit ihrem Inhalt aus stdin ab, auch in einem Unterordner', () => {
    const home = mkdtempSync(join(tmpdir(), 'acme-'));
    dir = home;
    execFileSync('bash', ['-c', fileScript(writeCredentialFileCommand(INFOBLOX_CA_FILE), home)], { input: `${PEM}\n` });
    expect(readFileSync(join(home, 'hapm-trust', 'infoblox.pem'), 'utf8')).toBe(`${PEM}\n`);

    execFileSync('bash', ['-c', fileScript(writeCredentialFileCommand(NSUPDATE_KEY_FILE), home)], { input: 'erste\n' });
    execFileSync('bash', ['-c', fileScript(writeCredentialFileCommand(NSUPDATE_KEY_FILE), home)], { input: 'zweite\n' });
    expect(readFileSync(join(home, 'hapm-nsupdate.key'), 'utf8')).toBe('zweite\n');
    // Keine halbe Datei bleibt liegen.
    expect(() => statSync(join(home, 'hapm-nsupdate.key.hapm-new'))).toThrow();
  });

  it('entfernt sie wieder und scheitert nicht, wenn sie fehlt', () => {
    const home = mkdtempSync(join(tmpdir(), 'acme-'));
    dir = home;
    writeFileSync(join(home, 'hapm-nsupdate.key'), 'x');
    execFileSync('bash', ['-c', fileScript(removeCredentialFileCommand(NSUPDATE_KEY_FILE), home)]);
    expect(() => statSync(join(home, 'hapm-nsupdate.key'))).toThrow();
    execFileSync('bash', ['-c', fileScript(removeCredentialFileCommand(NSUPDATE_KEY_FILE), home)]);
  });

  it('schreibt nur in den Ordner von acme.sh', () => {
    for (const path of ['/etc/passwd', '/root/.acme.sh/../.ssh/authorized_keys', '/root/.acme.sh/a b', '/root/.acme.sh/a/b/c', 'relativ.key']) {
      expect(() => writeCredentialFileCommand(path), path).toThrow();
      expect(() => removeCredentialFileCommand(path), path).toThrow();
    }
  });

  it('legt die Zertifizierungsstellen in den Bestand des Containers und nimmt entfernte wieder heraus', () => {
    const home = mkdtempSync(join(tmpdir(), 'acme-'));
    dir = home;
    const trust = join(home, 'hapm-trust');
    const store = join(home, 'store');
    const bin = join(home, 'bin');
    mkdirSync(trust);
    mkdirSync(store);
    mkdirSync(bin);
    // Ein Platzhalter für `update-ca-certificates`: er vermerkt nur, dass er lief.
    writeFileSync(join(bin, 'update-ca-certificates'), `#!/bin/sh\necho lief >> '${posix(join(home, 'log'))}'\n`, { mode: 0o755 });
    const script = TRUST_SYNC.replace('/root/.acme.sh/hapm-trust', posix(trust)).replace(
      '/usr/local/share/ca-certificates',
      posix(store)
    );
    const run = () =>
      execFileSync('bash', ['-c', script], { env: { ...process.env, PATH: `${posix(bin)}:${process.env.PATH}` } });
    const runs = () => {
      try {
        return readFileSync(join(home, 'log'), 'utf8').trim().split('\n').length;
      } catch {
        return 0;
      }
    };

    // Ohne Dateien geschieht nichts: der Start von HAPM kostet dann nichts.
    run();
    expect(runs()).toBe(0);

    writeFileSync(join(trust, 'infoblox.pem'), `${PEM}\n`);
    writeFileSync(join(store, 'fremd.crt'), 'gehört nicht HAPM');
    run();
    expect(readFileSync(join(store, 'hapm-trust-infoblox.crt'), 'utf8')).toBe(`${PEM}\n`);
    expect(runs()).toBe(1);

    // Entfernt: die Kopie geht, was HAPM nicht hingelegt hat, bleibt.
    rmSync(join(trust, 'infoblox.pem'));
    run();
    expect(() => statSync(join(store, 'hapm-trust-infoblox.crt'))).toThrow();
    expect(readFileSync(join(store, 'fremd.crt'), 'utf8')).toBe('gehört nicht HAPM');
    expect(runs()).toBe(2);

    run();
    expect(runs()).toBe(2);
  });
});
