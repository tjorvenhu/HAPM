import { describe, it, expect } from 'vitest';
import {
  createTranslator,
  interpolate,
  localeFromAcceptLanguage,
  lookup,
  msg,
  msgid,
  plural,
  resolveLocale,
  translate,
} from '@/lib/i18n';

/** Übersetzen, Platzhalter, Mehrzahl und die Wahl der Sprache. Alles ohne Server. */

describe('translate', () => {
  it('lässt Deutsch, wie es ist, und schlägt Englisch nach', () => {
    expect(translate('de', 'Abmelden')).toBe('Abmelden');
    expect(translate('en', 'Abmelden')).toBe('Sign out');
  });

  it('fällt ohne Eintrag auf den deutschen Text zurück, nie auf einen Schlüssel', () => {
    const missing = 'Diesen Text gibt es im Wörterbuch nicht.';
    expect(lookup('en', missing)).toBeUndefined();
    expect(translate('en', missing)).toBe(missing);
    expect(translate('en', 'Kein Eintrag für {name}.', { name: 'web' })).toBe('Kein Eintrag für web.');
  });

  it('setzt Platzhalter in beiden Sprachen ein', () => {
    expect(translate('de', 'Seiten im Bereich {area}', { area: 'System' })).toBe('Seiten im Bereich System');
    expect(translate('en', 'Seiten im Bereich {area}', { area: 'System' })).toBe('Pages in System');
  });

  it('nimmt eine Message mit ihren Parametern', () => {
    const message = msg('Mehr als {max} Passkeys je Konto sind nicht möglich', { max: 10 });
    expect(translate('de', message)).toBe('Mehr als 10 Passkeys je Konto sind nicht möglich');
    expect(translate('en', message)).toBe('No more than 10 passkeys per account');
  });

  it('msgid gibt den Text unverändert zurück', () => {
    expect(msgid('Konto')).toBe('Konto');
  });
});

describe('interpolate', () => {
  it('lässt einen Platzhalter ohne Wert stehen und formatiert Zahlen nicht', () => {
    expect(interpolate('{a} und {b}', { a: 1 })).toBe('1 und {b}');
    expect(interpolate('Port {port}', { port: 8080 })).toBe('Port 8080');
  });

  it('greift nicht auf geerbte Eigenschaften zu', () => {
    expect(interpolate('{constructor}', {})).toBe('{constructor}');
  });
});

describe('plural', () => {
  const forms = { one: '{count} Vorgang', other: '{count} Vorgänge' };

  it('wählt die Form nach der Anzahl, 0 ist Mehrzahl', () => {
    expect(plural('de', 1, forms)).toBe('1 Vorgang');
    expect(plural('de', 0, forms)).toBe('0 Vorgänge');
    expect(plural('en', 1, forms)).toBe('1 task');
    expect(plural('en', 3, forms)).toBe('3 tasks');
  });

  it('trennt Tausender nach der Sprache', () => {
    expect(plural('de', 1200, forms)).toBe('1.200 Vorgänge');
    expect(plural('en', 1200, forms)).toBe('1,200 tasks');
  });

  it('steht auch am Translator', () => {
    const translator = createTranslator('en');
    expect(translator.locale).toBe('en');
    expect(translator.t('Konto')).toBe('Account');
    expect(translator.plural(2, forms)).toBe('2 tasks');
  });
});

describe('localeFromAcceptLanguage', () => {
  it('nimmt Deutsch, wenn es vor Englisch steht oder Englisch fehlt', () => {
    expect(localeFromAcceptLanguage('de-DE,de;q=0.9,en;q=0.8')).toBe('de');
    expect(localeFromAcceptLanguage('de-AT')).toBe('de');
    expect(localeFromAcceptLanguage('fr-FR,de;q=0.5')).toBe('de');
  });

  it('nimmt Englisch, wenn es vorn steht oder keine der beiden genannt ist', () => {
    expect(localeFromAcceptLanguage('en-US,en;q=0.9,de;q=0.8')).toBe('en');
    expect(localeFromAcceptLanguage('fr-FR,fr;q=0.9')).toBe('en');
  });

  it('richtet sich nach der Gewichtung, nicht nach der Reihenfolge', () => {
    expect(localeFromAcceptLanguage('de;q=0.5,en;q=0.9')).toBe('en');
    expect(localeFromAcceptLanguage('en;q=0,de;q=0.1')).toBe('de');
  });

  it('bleibt ohne Kopfzeile bei Deutsch', () => {
    expect(localeFromAcceptLanguage(null)).toBe('de');
    expect(localeFromAcceptLanguage('')).toBe('de');
  });
});

describe('resolveLocale', () => {
  it('Konto vor Cookie vor Browser', () => {
    expect(resolveLocale({ user: 'en', cookie: 'de', acceptLanguage: 'de' })).toBe('en');
    expect(resolveLocale({ user: null, cookie: 'en', acceptLanguage: 'de' })).toBe('en');
    expect(resolveLocale({ user: null, cookie: null, acceptLanguage: 'en-GB' })).toBe('en');
  });

  it('übergeht unbekannte Werte', () => {
    expect(resolveLocale({ user: 'fr', cookie: 'xx', acceptLanguage: 'de' })).toBe('de');
  });
});
