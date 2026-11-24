/**
 * Ein Gruppen-Vorgang, der auf einer Seite startet und auf einer anderen zu
 * Ende geht.
 *
 * Das Entfernen wird auf der Gruppenseite ausgelöst — und danach gibt es diese
 * Seite gleich nicht mehr, also springt sie zurück auf die Übersicht. Ohne
 * Übergabe stünde die Gruppe dort weiter in der Liste, bis der nächste
 * 60-Sekunden-Takt sie abholt: für den Benutzer sieht das aus, als wäre der
 * Klick verlorengegangen.
 *
 * Eine Modulvariable und kein `sessionStorage`: der Vorgang lebt Sekunden, und
 * beide Seiten liegen im selben Bündel — ein Seitenwechsel im Client lässt das
 * Modul stehen. Ein echtes Neuladen verliert die Übergabe, und das ist richtig
 * so: dann hat die Liste ohnehin frisch gelesen.
 *
 * `takeScopeRun` liest EINMAL und räumt dabei ab. Sonst zeigte die Übersicht
 * beim nächsten Betreten wieder eine Karte für einen Vorgang, der längst durch
 * ist.
 */

export interface ScopeRunHandover {
  /** Der Name der Gruppe, wie er im Marker steht. */
  name: string;
  /** Die Route antwortet mit einer Liste von Läufen; in HAPM ist es einer. */
  runIds: string[];
  action: 'add' | 'remove';
}

let pending: ScopeRunHandover | null = null;

export function handOverScopeRun(run: ScopeRunHandover): void {
  pending = run;
}

export function takeScopeRun(): ScopeRunHandover | null {
  const run = pending;
  pending = null;
  return run;
}
