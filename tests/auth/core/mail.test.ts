import { describe, it, expect } from 'vitest';
import { resetPasswordMail, verifyEmailMail, changeEmailMail } from '@/lib/auth/core/mail';

const base = {
  appName: 'HAPM',
  userName: 'Erika Mustermann',
  url: 'https://example.test/passwort-neu?token=abc',
  expiresInSeconds: 3600,
};

describe('resetPasswordMail', () => {
  const mail = resetPasswordMail(base);

  it('nennt die Gültigkeitsdauer ausformuliert', () => {
    expect(mail.text).toContain('eine Stunde');
  });

  it('sagt, was zu tun ist, wenn es nicht der Empfänger war', () => {
    // Wer eine solche Mail ungefragt bekommt, hat genau eine Frage. Sie gehört
    // in die Mail, nicht in einen Hilfeartikel.
    expect(mail.text).toContain('Waren Sie das nicht');
    expect(mail.text).toContain('bleibt dann unverändert gültig');
  });

  it('zeigt den Link im Klartext, nicht hinter einem Knopf', () => {
    // Eine Nachricht mit einem Knopf, dessen Ziel man nicht sieht, ist die Form,
    // in der Betrugsmails auftreten. Ein sichtbarer Link ist prüfbar.
    expect(mail.text).toContain(base.url);
    expect(mail.text).not.toContain('<a ');
    expect(mail.text).not.toContain('<html');
  });

  it('unterschreibt mit dem Namen der Anwendung, nicht mit einer Firma', () => {
    // HAPM betreibt, wer es installiert hat. Wer unsicher ist, wird an den
    // Betreiber der Installation verwiesen.
    expect(mail.text.endsWith(`\n${base.appName}`)).toBe(true);
    expect(mail.text).toContain('den Betreiber dieser Installation');
    expect(mail.text).not.toMatch(/haftungsbeschränkt|GmbH|\bUG\b|\bAG\b/);
  });

  it('trägt den Namen der Anwendung im Betreff', () => {
    expect(mail.subject).toContain('HAPM');
  });
});

describe('Dauerangabe', () => {
  it('formuliert Stunden und Minuten passend', () => {
    expect(resetPasswordMail({ ...base, expiresInSeconds: 3600 }).text).toContain('eine Stunde');
    expect(resetPasswordMail({ ...base, expiresInSeconds: 7200 }).text).toContain('2 Stunden');
    expect(resetPasswordMail({ ...base, expiresInSeconds: 900 }).text).toContain('15 Minuten');
    expect(resetPasswordMail({ ...base, expiresInSeconds: 60 }).text).toContain('eine Minute');
  });
});

describe('verifyEmailMail', () => {
  it('sagt, dass Nichtstun folgenlos ist', () => {
    const mail = verifyEmailMail(base);
    expect(mail.text).toContain('Ohne Bestätigung passiert nichts weiter');
  });
});

describe('changeEmailMail', () => {
  const mail = changeEmailMail({ ...base, newEmail: 'neu@example.test' });

  it('sagt ausdrücklich, dass die Mail an die ALTE Adresse geht', () => {
    // Andersherum wäre die Bestätigung wirkungslos: wer ein Konto übernommen
    // hat, trägt seine eigene Adresse ein und bestätigt sich selbst.
    expect(mail.text).toContain('bisherige Adresse');
    expect(mail.text).toContain('neu@example.test');
  });

  it('warnt davor, den Link anzuklicken, statt zur Ignoranz zu raten', () => {
    // Bei den anderen Mails ist Ignorieren richtig. Hier nicht: ein fremder
    // Änderungsversuch ist ein laufender Angriff auf das Konto.
    expect(mail.text).toContain('NICHT');
    expect(mail.text).toContain('umgehend');
  });
});

/**
 * Text und Bestandteile stammen aus demselben Aufruf. Diese Tests halten fest,
 * dass sie nicht auseinanderlaufen — sonst weicht die HTML-Fassung
 * irgendwann vom Text ab, und welche gilt, entscheidet das Mailprogramm des
 * Empfängers.
 */
describe('Bestandteile und Text bleiben deckungsgleich', () => {
  const ctx = {
    appName: 'HAPM',
    userName: 'Erika Mustermann',
    url: 'https://hapm.example.org/reset-password?token=abc123',
    expiresInSeconds: 3600,
  };

  const builders = [
    ['resetPasswordMail', resetPasswordMail(ctx)],
    ['verifyEmailMail', verifyEmailMail(ctx)],
    ['changeEmailMail', changeEmailMail({ ...ctx, newEmail: 'neu@example.net' })],
  ] as const;

  for (const [name, mail] of builders) {
    describe(name, () => {
      it('nennt die Adresse im Text', () => {
        expect(mail.text).toContain(ctx.url);
        expect(mail.url).toBe(ctx.url);
      });

      it('trägt jeden Absatz auch im Text', () => {
        for (const paragraph of mail.paragraphs) {
          expect(mail.text).toContain(paragraph);
        }
        expect(mail.text).toContain(mail.disclaimer);
      });

      it('gibt die Teile für eine eigene Vorlage mit', () => {
        expect(mail.headline).toBeTruthy();
        expect(mail.paragraphs.length).toBeGreaterThan(0);
        expect(mail.userName).toBe(ctx.userName);
        expect(mail.expiresInSeconds).toBe(ctx.expiresInSeconds);
      });

      it('enthält kein HTML', () => {
        // Der Text ist die Rückfallebene. Tags darin stünden sichtbar da.
        expect(mail.text).not.toMatch(/<[a-z/][^>]*>/i);
      });
    });
  }
});
