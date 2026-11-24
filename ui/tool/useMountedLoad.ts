'use client';

import { useEffect } from 'react';

/**
 * Einmal laden, wenn die Komponente eingehängt wird.
 *
 * ── Warum das eine eigene Datei ist ──
 *
 * `react-hooks/set-state-in-effect` verbietet `setState` im Rumpf eines
 * Effekts, und die Regel hat recht: es erzwingt eine zweite Renderrunde. Für
 * „hole beim Einhängen die Daten" gibt es trotzdem keinen anderen Ort — die
 * Daten liegen hinter einer Anfrage, ein Startwert kann sie nicht enthalten,
 * und ein Laden im Klick-Handler gäbe es beim ersten Anzeigen gar nicht.
 *
 * `eslint.config.mjs` nimmt deshalb `app/**\/page.tsx` von der Regel aus. Die
 * Reiter unter `components/reverse-proxy/` laden wie eine Seite, liegen aber
 * nicht dort. Die Ausnahme auf ganze Verzeichnisse auszuweiten hieße, sie auch
 * allem zu geben, was dort künftig entsteht.
 *
 * **Ehrlich dazu:** die Regel schweigt hier nicht, weil das Problem gelöst
 * wäre, sondern weil sie durch den übergebenen Rückruf nicht hindurchsieht.
 * Der zweite Renderdurchlauf findet weiterhin statt. Legitim ist das aus
 * demselben Grund, aus dem die Seiten ausgenommen sind: die Daten liegen
 * hinter einer Anfrage, es gibt keinen Startwert, der sie enthalten könnte.
 * Der Gewinn dieser Datei ist deshalb nicht, die Regel zu umgehen, sondern
 * dass die Begründung an einer Stelle steht statt in jeder Komponente neu —
 * und dass die Regel für alles andere dort scharf bleibt.
 *
 * `load` muss mit `useCallback` stabil sein, sonst lädt jede Renderrunde neu.
 * Das ist keine zusätzliche Auflage: `exhaustive-deps` verlangt es an der
 * Aufrufstelle ohnehin.
 *
 * Nicht zu verwechseln mit `usePolling` (holt wiederholt) und `useNow` (lässt
 * Vorhandenes altern). Dieser hier feuert genau einmal je `load`.
 */
export function useMountedLoad(load: () => void | Promise<void>): void {
  useEffect(() => {
    void load();
  }, [load]);
}
