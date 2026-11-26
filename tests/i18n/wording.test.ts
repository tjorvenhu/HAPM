import { describe, it, expect } from 'vitest';
import { en } from '@/lib/i18n/en';

/**
 * Ein Wort für das Wegnehmen: „Entfernen". Knöpfe, Titel von Rückfragen und
 * Beschriftungen heißen nie „Löschen", egal ob Ziel, Benutzer oder Zertifikat.
 *
 * Geprüft werden die Schlüssel des Wörterbuchs: jeder Text der Oberfläche ist
 * dort einer. Sätze, die eine Folge beschreiben („… löscht alle Passkeys."),
 * trifft das Muster nicht: sie enden nicht auf das Verb.
 */
describe('Wortwahl', () => {
  it('nennt keine Handlung „Löschen"', () => {
    const labels = Object.keys(en).filter((key) => /(^|\s)[Ll]öschen\??$/.test(key) || key.startsWith('Löschen'));
    expect(labels).toEqual([]);
  });
});
