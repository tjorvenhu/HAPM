import { describe, it, expect } from 'vitest';
import { serverNames } from '@/lib/haproxy/config';

/**
 * Das Formular zeigt keine Servernamen mehr. Gelesene Namen behält es, eine neue
 * Zeile kommt leer an. Der Name, den sie bekommt, darf mit keinem gelesenen
 * zusammenfallen: zwei gleich benannte Server lehnt HAProxy ab.
 */
describe('serverNames', () => {
  it('zählt ohne gesetzte Namen nach Position, wie bisher', () => {
    expect(serverNames([{ name: '' }, { name: '' }, { name: '' }])).toEqual(['server1', 'server2', 'server3']);
  });

  it('behält gesetzte Namen', () => {
    expect(serverNames([{ name: 'web-a' }, { name: 'web-b' }])).toEqual(['web-a', 'web-b']);
  });

  it('weicht einem gelesenen Namen aus, statt ihn zu doppeln', () => {
    // Aus server1, server2 wurde die erste Zeile entfernt und eine neue angehängt.
    expect(serverNames([{ name: 'server2' }, { name: '' }])).toEqual(['server2', 'server3']);
  });

  it('weicht auch einem Namen aus, der weiter hinten steht', () => {
    expect(serverNames([{ name: '' }, { name: 'server1' }])).toEqual(['server2', 'server1']);
  });

  it('vergibt zwei leeren Zeilen nie denselben Namen', () => {
    const names = serverNames([{ name: '' }, { name: 'server3' }, { name: '' }, { name: '' }]);
    expect(new Set(names).size).toBe(names.length);
  });
});
