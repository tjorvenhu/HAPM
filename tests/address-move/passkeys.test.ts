import { describe, it, expect } from 'vitest';
import { passkeysDroppedBy } from '@/lib/settings';

/**
 * Wann ein Wechsel der Adresse die Passkeys löscht (`updateSettings`): sie
 * hängen an der Domain, nicht an Schema oder Port.
 */
describe('passkeysDroppedBy', () => {
  const at = (publicUrl: string | null) => ({ publicUrl });

  it('löscht bei einer anderen Domain und beim Entfernen der Adresse', () => {
    expect(passkeysDroppedBy(at('https://hapm.example.org'), at('https://neu.example.org'))).toBe(true);
    expect(passkeysDroppedBy(at('https://hapm.example.org'), at(null))).toBe(true);
  });

  it('lässt sie bei derselben Domain und ohne Adresse davor stehen', () => {
    expect(passkeysDroppedBy(at('https://hapm.example.org'), at('https://hapm.example.org'))).toBe(false);
    expect(passkeysDroppedBy(at('https://hapm.example.org'), at('https://hapm.example.org:8443'))).toBe(false);
    expect(passkeysDroppedBy(at(null), at('https://hapm.example.org'))).toBe(false);
  });
});
