import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DNS_PROVIDERS,
  findDnsProvider,
  validateDnsCredentials,
  credentialLines,
  writeCredentialsCommand,
} from '@/lib/haproxy/dns-credentials';

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
function scriptFor(names: string[], conf: string): string {
  return writeCredentialsCommand(names).replace(
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

const EXISTING = [
  "ACCOUNT_EMAIL='ops@example.org'",
  "SAVED_CF_Token='alterwert'",
  "SAVED_HETZNER_Token='fremderanbieter'",
  'UPGRADE_HASH=abc',
  '',
].join('\n');

describe('writeCredentialsCommand', () => {
  it('ersetzt den eigenen Wert und lässt alles andere stehen', () => {
    const { text } = runAgainst(EXISTING, ['CF_Token', 'CF_Account_ID'], "SAVED_CF_Token='neu'\n");

    expect(text).toContain("SAVED_CF_Token='neu'");
    expect(text).not.toContain('alterwert');
    // Der andere Anbieter und die übrigen Zeilen bleiben unangetastet.
    expect(text).toContain("SAVED_HETZNER_Token='fremderanbieter'");
    expect(text).toContain("ACCOUNT_EMAIL='ops@example.org'");
    expect(text).toContain('UPGRADE_HASH=abc');
  });

  it('entfernt bei leerem stdin nur die eigenen Zeilen', () => {
    const { text } = runAgainst(EXISTING, ['CF_Token', 'CF_Account_ID'], '');

    expect(text).not.toContain('SAVED_CF_Token');
    expect(text).toContain("SAVED_HETZNER_Token='fremderanbieter'");
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
      validateDnsCredentials({ ...cf, values: { CF_Token: 'abc', HETZNER_Token: 'x' } })
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
