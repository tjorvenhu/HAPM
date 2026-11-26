import { describe, it, expect } from 'vitest';
import { validateAcmeEmail } from '@/lib/validation';

/**
 * acme.sh schreibt die Kontaktadresse in eine Datei, die es als Shell liest.
 * Durchgehen darf nur, was dort nichts anrichtet.
 */
describe('validateAcmeEmail', () => {
  it('nimmt übliche Adressen', () => {
    for (const email of ['ops@example.org', 'first.last+acme@sub.example.co.uk', 'a_b-c%d@ex-ample.de']) {
      expect(validateAcmeEmail(email), email).toBe(true);
    }
  });

  it('lehnt ab, was eine Shell anders läse', () => {
    for (const email of [
      "x'&touch${IFS}/tmp/p&'y@example.org",
      'a$(id)@example.org',
      'a`id`@example.org',
      'a;b@example.org',
      'a"b@example.org',
      'a@example.org; reboot',
      'a b@example.org',
      'a@b',
      '',
    ]) {
      expect(validateAcmeEmail(email), email).toBe(false);
    }
  });
});
