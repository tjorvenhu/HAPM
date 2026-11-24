import { describe, expect, it } from 'vitest';
import {
  MAIL_LOGO_CID,
  MAIL_LOGO_DARK_CID,
  mailFacts,
  mailNote,
  mailText,
  MAIL_REASON,
  renderHapmMail,
} from '@/lib/mail/layout';

/**
 * Der Rahmen steht in `ui/mail/layout.ts`, `renderHapmMail` nennt ihm den
 * Absender: diese Installation. HAPM betreibt, wer es installiert hat. Die
 * Prüfungen halten fest, dass im Fuß der Server und die Adresse der Oberfläche
 * stehen und dass keine Mail Angaben oder die Grußformel einer Firma trägt.
 */

/** Was nur in der Geschäftspost einer Firma steht. */
const COMPANY_FRAGMENTS = [
  'USt-IdNr',
  'Steuernr',
  'Amtsgericht',
  'HRB',
  'haftungsbeschränkt',
  'GmbH',
  'Impressum',
  'Datenschutz',
  'mailto:',
  'Mit freundlichen',
];
/** „Ihr …-Team" und „Ihr … Team": die Unterschrift einer Firma. */
const COMPANY_CLOSING = /\b(Ihr|Dein|Euer)\s+\S+[- ]Team\b/;

const installation = { nodeName: 'proxy01', publicUrl: 'https://hapm.example.org' };

const content = {
  subject: 'HAProxy läuft nicht',
  heading: 'HAProxy läuft nicht',
  body:
    mailText('Der Container <strong>hapm-haproxy</strong> läuft nicht.') +
    mailFacts([{ label: 'Zustand', value: 'exited' }]) +
    mailNote('Ausgabe &lt;leer&gt;', 'danger', 'Fehler'),
};

describe('renderHapmMail', () => {
  const { html, text } = renderHapmMail(
    { ...content, eyebrow: 'Reverse-Proxy', action: { label: 'Übersicht öffnen', url: 'https://hapm.example.org/dashboard' } },
    installation
  );

  it('baut die Mail im Rahmen', () => {
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<title>HAProxy läuft nicht</title>');
    expect(html).toContain('Reverse-Proxy');
    expect(html).toContain(`cid:${MAIL_LOGO_CID}`);
    expect(html).toContain(`cid:${MAIL_LOGO_DARK_CID}`);
    expect(html).toContain('https://hapm.example.org/dashboard');
  });

  it('nennt im Fuß diese Installation', () => {
    const footer = /<td class="v-foot"[^>]*>([\s\S]*?)<\/td><\/tr>/.exec(html)?.[1] ?? '';
    expect(footer).toContain('>HAPM</p>');
    expect(footer).toContain('Diese Mail kommt von der HAPM-Installation auf dem Server proxy01.');
    expect(footer).toContain('<a href="https://hapm.example.org"');
    expect(footer).toContain('hapm.example.org</a>');
    // Zwei Absätze: der Name und die Zeilen zum Absender. Der Link trägt die
    // Schreibweise des Fußes (gedämpft, unterstrichen), nicht die des Inhalts.
    expect(footer.match(/<p\b/g)?.length).toBe(2);
    expect(footer).toMatch(/<a href="https:\/\/hapm\.example\.org" class="v-muted" style="[^"]+">/);
  });

  it('sagt im Fuß, warum man die Mail bekommt', () => {
    const footer = /<td class="v-foot"[^>]*>([\s\S]*?)<\/td><\/tr>/.exec(html)?.[1] ?? '';
    expect(footer).toContain(MAIL_REASON);
    expect(text).toContain(MAIL_REASON);
    expect(MAIL_REASON).toContain('Konto');
    expect(MAIL_REASON).toContain('Benachrichtigungen');
  });

  it('trägt keine Firmenangaben und keine Grußformel', () => {
    for (const body of [html, text]) {
      for (const fragment of COMPANY_FRAGMENTS) expect(body).not.toContain(fragment);
      expect(body).not.toMatch(COMPANY_CLOSING);
    }
    expect(html).not.toContain('href="https://"');
    expect(html).not.toContain('href="https:///');
  });

  it('liefert eine Textfassung mit demselben Inhalt', () => {
    expect(text.startsWith('HAProxy läuft nicht')).toBe(true);
    expect(text).toContain('Der Container hapm-haproxy läuft nicht.');
    expect(text).toContain('Zustand: exited');
    expect(text).toContain('Ausgabe <leer>');
    expect(text).toContain('Übersicht öffnen: https://hapm.example.org/dashboard');
    expect(text).toContain('Diese Mail kommt von der HAPM-Installation auf dem Server proxy01.');
    expect(text.endsWith('Oberfläche: https://hapm.example.org')).toBe(true);
    expect(text).not.toMatch(/<\/?(p|table|tr|td|div|span|strong|a)\b/i);
  });

  it('kommt ohne Adresse der Oberfläche aus', () => {
    const plain = renderHapmMail(content, { nodeName: 'proxy01', publicUrl: null });
    const footer = /<td class="v-foot"[^>]*>([\s\S]*?)<\/td><\/tr>/.exec(plain.html)?.[1] ?? '';
    expect(footer).toContain('auf dem Server proxy01');
    expect(footer).not.toContain('<a ');
    expect(plain.text).toContain('HAPM-Installation auf dem Server proxy01');
    expect(plain.text).not.toContain('Oberfläche');
    expect(plain.text).not.toContain('https://');
  });

  it('lässt einen Knopf ohne http-Adresse weg, im HTML wie im Text', () => {
    const mail = renderHapmMail({ ...content, action: { label: 'Öffnen', url: '/dashboard' } }, installation);
    expect(mail.html).not.toContain('>Öffnen<');
    expect(mail.text).not.toContain('Öffnen');
  });

  it('maskiert den Namen des Servers', () => {
    const mail = renderHapmMail(content, { nodeName: '<script>x</script>', publicUrl: null });
    expect(mail.html).not.toContain('<script>x</script>');
    expect(mail.html).toContain('&lt;script&gt;');
  });

  it('nimmt die Zeile des Aufrufers über dem Absender mit', () => {
    const mail = renderHapmMail({ ...content, footerNote: 'Einstellbar unter „Benachrichtigungen“.' }, installation);
    const footer = /<td class="v-foot"[^>]*>([\s\S]*?)<\/td><\/tr>/.exec(mail.html)?.[1] ?? '';
    expect(footer.indexOf('Einstellbar')).toBeGreaterThanOrEqual(0);
    expect(footer.indexOf('Einstellbar')).toBeLessThan(footer.indexOf('>HAPM</p>'));
    expect(mail.text).toContain('Einstellbar unter „Benachrichtigungen“.');
  });

  it('schreibt den Rahmen in der Sprache der Installation', () => {
    const mail = renderHapmMail(
      { ...content, action: { label: 'Open', url: 'https://hapm.example.org/dashboard' } },
      { ...installation, locale: 'en' }
    );
    expect(mail.html).toContain('<html lang="en"');
    expect(mail.html).toContain('Or open this link in your browser:');
    expect(mail.text).toContain('This email comes from the HAPM installation on the server proxy01.');
    expect(mail.text.endsWith('Interface: https://hapm.example.org')).toBe(true);
    expect(mail.html).not.toMatch(/Diese Mail|Oberfl|Oder diesen Link/);
    expect(html).toContain('<html lang="de"');
  });

  it('geht mit der Zusage aus drei Feldern und ohne zweite Angabe', () => {
    const mail = renderHapmMail({ subject: 'Betreff', heading: 'Überschrift', body: mailText('Inhalt.') });
    expect(mail.html).toContain('Überschrift');
    expect(mail.text).toContain('Inhalt.');
    expect(mail.html).not.toMatch(COMPANY_CLOSING);
    expect(mail.html).not.toContain('Mit freundlichen');
  });
});
