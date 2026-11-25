import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  effectiveAcmeServer,
  registerAccountInput,
  registerAccountScript,
  validateAcmeDirectory,
  validateEab,
} from '@/lib/acme-server';
import { withStdin } from '@/lib/shell';
import { germanText } from '@/lib/i18n/translate';

/**
 * Der eigene ACME-Server: welche Adresse durchgeht, und dass der
 * HMAC-Schlüssel bei der Anmeldung in keiner Kommandozeile steht.
 */

describe('effectiveAcmeServer', () => {
  it('Einstellung vor Umgebung vor Let\'s Encrypt', () => {
    expect(effectiveAcmeServer(null, undefined)).toBe('letsencrypt');
    expect(effectiveAcmeServer(null, ' letsencrypt_test ')).toBe('letsencrypt_test');
    expect(effectiveAcmeServer('https://ca.example.org/dir', 'letsencrypt_test')).toBe('https://ca.example.org/dir');
  });
});

describe('validateAcmeDirectory', () => {
  it.each([
    'https://ca.example.org/acme/acme/directory',
    'https://ca.internal:9000/acme/acme/directory',
    'https://10.0.0.5:9000/acme/hapm/directory',
    'https://acme.zerossl.com/v2/DV90',
  ])('nimmt %s', (url) => {
    expect(validateAcmeDirectory(url)).toBeNull();
  });

  it.each([
    ['', 'Directory-URL'],
    ['http://ca.example.org/directory', 'https://'],
    ["https://ca.example.org/dir'x", 'Zeichen'],
    ['https://ca.example.org/dir?x=1', 'Zeichen'],
    ['https://ca.example.org/dir dir', 'Zeichen'],
    ['https://user:pass@ca.example.org/dir', 'Zeichen'],
    ['https://ca.example.org/$(id)', 'Zeichen'],
    ['https://-ca.example.org/dir', 'Servernamen'],
  ])('lehnt %s ab', (url, expected) => {
    const message = validateAcmeDirectory(url);
    expect(message).not.toBeNull();
    expect(germanText(message!)).toContain(expected);
  });
});

describe('validateEab', () => {
  it('beides oder keins', () => {
    expect(validateEab({ keyId: '', hmacKey: '' })).toBeNull();
    expect(validateEab({ keyId: 'kid-123', hmacKey: 'c2VjcmV0LWhtYWMta2V5LWJhc2U2NA' })).toBeNull();
    expect(germanText(validateEab({ keyId: 'kid-123', hmacKey: '' })!)).toContain('beides');
    expect(germanText(validateEab({ keyId: '', hmacKey: 'abcdefghij' })!)).toContain('beides');
  });

  it('lehnt ab, was acme.sh beim Einlesen seiner ca.conf aufbräche', () => {
    expect(validateEab({ keyId: "kid'x", hmacKey: 'abcdefghij' })).not.toBeNull();
    expect(validateEab({ keyId: 'kid', hmacKey: "abc'defghij" })).not.toBeNull();
    expect(validateEab({ keyId: 'kid', hmacKey: 'abc def ghij' })).not.toBeNull();
  });
});

describe('registerAccountScript', () => {
  /**
   * Ein falsches acme.sh, das seine Argumente und die Kommandozeile seines
   * Prozesses aufschreibt. Echt ist daran die Shell: sie liest die Werte von
   * stdin, setzt sie als Argumente und liest das Skript mit `.` ein.
   */
  function run(input: string): { args: string[]; cmdline: string } {
    const dir = mkdtempSync(join(tmpdir(), 'hapm-acme-'));
    try {
      const fake = join(dir, 'acme.sh');
      const out = join(dir, 'out');
      writeFileSync(
        fake,
        [
          `for a in "$@"; do printf '%s\\n' "$a"; done > '${out}'`,
          // Was `ps` über diesen Prozess sähe.
          `ps -o args= -p $$ > '${out}.cmd'`,
        ].join('\n')
      );
      chmodSync(fake, 0o755);
      execFileSync('bash', ['-c', withStdin(['sh', '-c', registerAccountScript('/root/.acme.sh'), fake], input)]);
      return {
        args: readFileSync(out, 'utf8').trimEnd().split('\n'),
        cmdline: readFileSync(`${out}.cmd`, 'utf8'),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('meldet mit EAB an, und der Schlüssel steht nicht in der Kommandozeile', () => {
    const hmac = 'c2VjcmV0LWhtYWMta2V5LWJhc2U2NA';
    const { args, cmdline } = run(
      registerAccountInput('https://ca.example.org/dir', 'admin@example.org', { keyId: 'kid-1', hmacKey: hmac })
    );
    expect(args).toEqual([
      '--register-account',
      '--home',
      '/root/.acme.sh',
      '--server',
      'https://ca.example.org/dir',
      '--accountemail',
      'admin@example.org',
      '--eab-kid',
      'kid-1',
      '--eab-hmac-key',
      hmac,
    ]);
    expect(cmdline).not.toContain(hmac);
  });

  it('ohne Adresse und ohne EAB nur der Server', () => {
    const { args } = run(registerAccountInput('https://ca.example.org/dir', null, null));
    expect(args).toEqual(['--register-account', '--home', '/root/.acme.sh', '--server', 'https://ca.example.org/dir']);
  });

  it('ein Zeilenumbruch in einem Wert verschöbe die Zeilen und wird abgelehnt', () => {
    expect(() => registerAccountInput('https://ca.example.org/dir\nx', null, null)).toThrow();
  });
});
