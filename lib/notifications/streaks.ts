/**
 * Zwei Prüfungen in Folge, bevor etwas gemeldet wird.
 *
 * Eine einzelne Beobachtung kann täuschen: HAProxy lädt gerade neu, ein Ziel
 * startet neu, ein Container wird beim Update ersetzt. Gemeldet wird erst, was
 * bei der nächsten Runde noch so ist. Rein, damit sich die Regel ohne HAProxy
 * prüfen lässt.
 */

export type Observed = 'down' | 'up';

export interface Streak {
  state: Observed;
  count: number;
  /** Wann der Zustand zum ersten Mal so gesehen wurde. */
  since: string;
}

/** So oft muss ein Zustand hintereinander gesehen werden. */
export const CONFIRM_AFTER = 2;

export interface StreakStep {
  streaks: Map<string, Streak>;
  /** Fällt gerade aus oder ist weiter ausgefallen: jede Runde wieder, die Dämpfung entscheidet. */
  down: { id: string; since: string }[];
  /** In dieser Runde zum zweiten Mal erreichbar gesehen: genau einmal je Wechsel. */
  recovered: string[];
}

/**
 * Eine Runde auswerten. `observations` nennt nur, worüber etwas bekannt ist:
 * ein Eintrag, der fehlt (Zustand unbekannt, gelöscht), verliert seine Reihe
 * und fängt beim nächsten Mal von vorn an.
 */
export function advanceStreaks(
  previous: ReadonlyMap<string, Streak>,
  observations: ReadonlyMap<string, Observed>,
  now: string
): StreakStep {
  const streaks = new Map<string, Streak>();
  const down: StreakStep['down'] = [];
  const recovered: string[] = [];

  for (const [id, state] of observations) {
    const before = previous.get(id);
    const streak: Streak =
      before && before.state === state
        ? { ...before, count: before.count + 1 }
        : { state, count: 1, since: now };
    streaks.set(id, streak);

    if (streak.count < CONFIRM_AFTER) continue;
    if (state === 'down') down.push({ id, since: streak.since });
    else if (streak.count === CONFIRM_AFTER) recovered.push(id);
  }

  return { streaks, down, recovered };
}
