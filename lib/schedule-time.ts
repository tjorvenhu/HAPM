/**
 * Ob eine tägliche Uhrzeit (`HH:MM`, Zeitzone aus `TZ`) zwischen zwei Takten
 * erreicht wurde.
 *
 * Nicht der Vergleich mit der Minute der Uhr: am Tag der Umstellung auf
 * Sommerzeit gibt es 02:00 bis 02:59 nicht (die Sicherung um 02:30 fiele aus),
 * und ein Takt, der sich um Millisekunden verschiebt, überspringt irgendwann
 * eine Minute. Hier zählt, ob der Zeitpunkt im Abstand seit dem letzten Takt
 * liegt. Eine Uhrzeit, die es an dem Tag nicht gibt, rückt `Date` eine Stunde
 * weiter; eine, die es zweimal gibt, gilt beim ersten Mal. Geprüft wird für
 * den Tag beider Enden, damit ein Takt über Mitternacht nichts verliert.
 */
export function timeReached(time: string, from: number, to: number): boolean {
  const [hours, minutes] = time.split(':').map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return false;
  return [from, to].some((moment) => {
    const day = new Date(moment);
    const target = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes, 0, 0).getTime();
    return target > from && target <= to;
  });
}
