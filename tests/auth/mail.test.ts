import { describe, expect, it } from 'vitest';
import { resetPasswordMail } from '@/lib/auth/core/mail';
import { authMail, passkeyChangeMail } from '@/lib/auth/mail';

/**
 * Die Mails der Anmeldung. HAPM betreibt, wer es installiert hat: in keiner
 * Mail darf deshalb eine Firma als Absender stehen.
 */

const URL = 'https://hapm.example.org/reset-password?token=abc123';

const reset = authMail(
  resetPasswordMail({ appName: 'HAPM', userName: 'Anna <b>', url: URL, expiresInSeconds: 3600 })
);

describe('Mail zum Zurücksetzen des Passworts', () => {
  it('nennt Anlass, Frist und die Adresse lesbar', () => {
    expect(reset.subject).toBe('HAPM: neues Passwort festlegen');
    for (const body of [reset.html, reset.text]) {
      expect(body).toContain('eine Stunde');
      expect(body).toContain('abc123');
      expect(body).toContain('Waren Sie das nicht');
    }
    expect(reset.text).toContain(`Passwort festlegen: ${URL}`);
  });

  it('nennt keinen fremden Absender', () => {
    for (const body of [reset.html, reset.text]) {
      expect(body).not.toMatch(/haftungsbeschränkt|GmbH|\bUG\b|Impressum|Mit freundlichen/);
      expect(body).toContain('HAPM-Installation auf dem Server');
    }
  });

  it('maskiert, was aus dem Konto kommt', () => {
    expect(reset.html).not.toContain('Anna <b>');
    expect(reset.html).toContain('Anna &lt;b&gt;');
  });
});

describe('Mail über einen Passkey', () => {
  it('sagt, was geschah, welcher Passkey es war und was zu tun ist', () => {
    const added = passkeyChangeMail(
      { userName: 'Anna', passkeyName: 'Mein <Mac>', change: 'added' },
      'https://hapm.example.org'
    );
    expect(added.subject).toBe('Neuer Passkey an Ihrem Konto');
    expect(added.html).toContain('Mein &lt;Mac&gt;');
    expect(added.html).not.toContain('Mein <Mac>');
    expect(added.text).toContain('Das waren nicht Sie?');
    expect(added.text).toContain('Konto öffnen: https://hapm.example.org/konto');

    const removed = passkeyChangeMail({ userName: '', passkeyName: 'iPhone', change: 'removed' }, null);
    expect(removed.subject).toBe('Passkey von Ihrem Konto entfernt');
    expect(removed.text).toContain('Hallo,');
    expect(removed.text).not.toContain('Konto öffnen');
  });
});
