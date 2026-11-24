'use client';

import { useEffect, useState } from 'react';

/**
 * Eine tickende Uhr für alles, was relativ zur Gegenwart angezeigt wird.
 *
 * `usePolling` holt neue Daten, das hier lässt die vorhandenen altern. Ohne den
 * Unterschied steht "vor 11 Sekunden" so lange still, bis der nächste
 * Ladevorgang kommt, und springt dann auf "vor 3 Sekunden" — die Angabe sieht
 * eingefroren aus, obwohl die Seite arbeitet. Genauso die Laufzeit eines
 * Servers: sie wächst, auch wenn niemand nachfragt.
 *
 * Dieselben zwei Regeln wie bei usePolling:
 *  - Ein versteckter Tab tickt nicht. Ein Timer, der einmal pro Sekunde eine
 *    Seite neu zeichnet, die niemand sieht, ist reine Rechenzeit.
 *  - Beim Zurückkommen sofort nachziehen statt ein Intervall abzuwarten, sonst
 *    steht dort für eine Sekunde eine Zahl von vor einer Stunde.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (intervalMs <= 0) return;

    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      setNow(Date.now());
    };

    const id = setInterval(tick, intervalMs);
    const onVisible = () => {
      if (!document.hidden) setNow(Date.now());
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs]);

  return now;
}
