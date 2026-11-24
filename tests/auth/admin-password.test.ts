import { describe, expect, it } from 'vitest';
import { hashPassword as hashByService, verifyPassword } from 'better-auth/crypto';
import { hashPassword, newPassword } from '@/bin/admin-password.mjs';
import { validatePassword } from '@/lib/validation';

/**
 * `hapm-admin reset-password` schreibt seinen Hash am Anmeldedienst vorbei in
 * die Datenbank. Nimmt der Dienst ihn nicht an, merkt man das erst, wenn jemand
 * ausgesperrt ist und der Notweg nicht funktioniert.
 */
describe('hapm-admin: Passwort und Hash', () => {
  it('schreibt einen Hash, den der Anmeldedienst annimmt', async () => {
    const hash = await hashPassword('Neues-Passwort-1');
    expect(await verifyPassword({ hash, password: 'Neues-Passwort-1' })).toBe(true);
    expect(await verifyPassword({ hash, password: 'Anderes-Passwort-1' })).toBe(false);
  });

  it('hat die Form der Hashes des Dienstes und jedes Mal ein neues Salz', async () => {
    const [own, service] = await Promise.all([hashPassword('Neues-Passwort-1'), hashByService('Neues-Passwort-1')]);
    expect(own).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(service).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(await hashPassword('Neues-Passwort-1')).not.toBe(own);
  });

  it('normalisiert das Passwort wie der Dienst', async () => {
    // „é" als ein Zeichen und als e mit Akzent: dasselbe Passwort.
    const hash = await hashPassword('Café-Passwort-1');
    expect(await verifyPassword({ hash, password: 'Café-Passwort-1' })).toBe(true);
  });

  it('erzeugt ein Passwort, das die Regeln der Oberfläche erfüllt', () => {
    for (let i = 0; i < 20; i++) expect(validatePassword(newPassword())).toBeNull();
    expect(newPassword()).not.toBe(newPassword());
  });
});
