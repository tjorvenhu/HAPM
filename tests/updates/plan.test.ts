import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { HANDOVER_STEP, UPDATE_PLAN, remainingSteps } from '@/lib/updates/plan';

describe('UPDATE_PLAN', () => {
  // `apply.ts` schreibt die Schritte als Text. Heißt dort einer anders, zeigt die
  // Seite „Updates" einen Schritt als ausstehend, der nie kommt.
  const source = fs.readFileSync(path.resolve(__dirname, '../../lib/updates/apply.ts'), 'utf8');

  it('nennt nur Schritte, die apply.ts unter diesem Namen schreibt', () => {
    for (const label of new Set(Object.values(UPDATE_PLAN).flat())) {
      expect(source, label).toContain(`'${label}'`);
    }
  });

  it('führt die Übergabe im Ablauf von HAPM', () => {
    expect(UPDATE_PLAN.hapm).toContain(HANDOVER_STEP);
  });
});

describe('remainingSteps', () => {
  it('nennt am Anfang den ganzen Ablauf', () => {
    expect(remainingSteps('haproxy', [])).toEqual(UPDATE_PLAN.haproxy);
  });

  it('beginnt hinter dem letzten gemeldeten Schritt', () => {
    expect(
      remainingSteps('haproxy', [
        { label: 'Abbild holen', ok: true },
        { label: 'Konfiguration mit der neuen Fassung prüfen', ok: true },
      ])
    ).toEqual(['Container ersetzen', 'Altes Abbild entfernen']);
  });

  it('ist leer, sobald ein Schritt gescheitert ist', () => {
    expect(remainingSteps('haproxy', [{ label: 'Abbild holen', ok: true }, { label: 'Abbruch', ok: false }])).toEqual([]);
  });

  it('ist leer nach dem letzten Schritt', () => {
    expect(remainingSteps('acme', [{ label: 'acme.sh aktualisieren', ok: true }])).toEqual([]);
  });

  it('lässt sich von einem unbekannten Schritt nicht beirren', () => {
    expect(remainingSteps('hapm', [{ label: 'Abbild holen', ok: true }, { label: 'Etwas Neues', ok: true }])).toEqual([
      HANDOVER_STEP,
      'Neuer Container',
    ]);
  });
});
