import { describe, it, expect } from 'vitest';
import { checkGate, movePlan, moveOutcome, newMoveStages, offerRecord } from '@/lib/address-move/rules';

/**
 * Die Regeln des Umzugs auf eine neue Adresse: Reihenfolge der Schritte, wann
 * die DNS-Prüfung den Weg freigibt und wann der Assistent anbietet, den
 * Eintrag selbst zu setzen.
 */

describe('movePlan', () => {
  it('entfernt das alte Ziel zuletzt, erst nach dem Umstellen der Adresse', () => {
    expect(movePlan(true)).toEqual(['certificate', 'service', 'publicUrl', 'cleanup']);
  });

  it('kennt ohne alte Adresse nichts zum Entfernen', () => {
    expect(movePlan(false)).toEqual(['certificate', 'service', 'publicUrl']);
  });
});

describe('moveOutcome', () => {
  const stages = newMoveStages(movePlan(true));

  it('unterscheidet laufend, fertig und gescheitert', () => {
    expect(moveOutcome(null)).toBe('idle');
    expect(moveOutcome({ running: true, stages })).toBe('running');
    expect(moveOutcome({ running: false, stages: stages.map((s) => ({ ...s, status: 'ok' as const })) })).toBe('succeeded');
    expect(
      moveOutcome({ running: false, stages: stages.map((s, i) => ({ ...s, status: i === 1 ? ('error' as const) : ('ok' as const) })) })
    ).toBe('failed');
  });

  it('liest einen Umzug, der ohne Ergebnis stehen blieb, als gescheitert', () => {
    // Ein Neustart mitten im Umzug: nicht mehr am Laufen, aber nicht fertig.
    expect(moveOutcome({ running: false, stages })).toBe('failed');
  });
});

describe('checkGate', () => {
  it('lässt nur bei einem Eintrag auf diesen Server ohne Rückfrage weiter', () => {
    expect(checkGate('matches')).toBe('go');
    expect(checkGate('elsewhere')).toBe('confirm');
    expect(checkGate('unknown')).toBe('confirm');
  });

  it('hält ohne Eintrag an: danach wäre HAPM unter keiner Adresse erreichbar', () => {
    expect(checkGate('unresolved')).toBe('blocked');
  });
});

describe('offerRecord', () => {
  it('bietet den Eintrag nur aus dem Internet, ohne Eintrag und mit eingerichteter Zone an', () => {
    expect(offerRecord('public', 'unresolved', true)).toBe(true);
    expect(offerRecord('public', 'unresolved', false)).toBe(false);
    expect(offerRecord('public', 'matches', true)).toBe(false);
    expect(offerRecord('public', 'elsewhere', true)).toBe(false);
    expect(offerRecord('internal', 'unresolved', true)).toBe(false);
  });
});
