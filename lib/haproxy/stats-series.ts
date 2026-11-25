/**
 * Aus Messzeilen werden Diagrammpunkte.
 *
 * Die Route darüber (`app/api/haproxy/stats/route.ts`) liest und antwortet; das
 * Rechnen steht hier, aus dem Grund, aus dem in diesem Repo alles Rechnende in
 * `lib/` steht: es soll prüfbar sein, ohne dass eine Datenbank läuft. Die
 * Grenzfälle sind sonst nicht zu treffen — der Messpunkt ohne Vorgängerin, die
 * Spalte, die es nur in einer BACKEND-Zeile gibt, das Fenster, in dem gar keine
 * Anfrage kam.
 *
 * Ohne Laufzeit-Importe: `HaproxyMetric` kommt als reiner Typ herein.
 *
 * ── Warum überhaupt verdichtet wird ──
 *
 * Dreißig Tage im Fünf-Minuten-Takt sind 8640 Punkte je Reihe für ein Diagramm,
 * das 900 Pixel breit ist. Neun von zehn Punkten wären Bytes über die Leitung
 * und Arbeit für den Browser, ohne dass ein Pixel dazukäme.
 */

import type { HaproxyMetric } from '../types';

/**
 * Der Erfassungstakt.
 *
 * Er steht hier und nicht in `./stats-collect.ts`, wo erfasst wird, und der
 * Grund ist die Oberfläche: die Live-Kennzahlen (`./stats-live.ts`, im Browser
 * importiert) rechnen damit. `stats-collect.ts` zieht über `lib/db` und `lib/ssh` den
 * Postgres-Treiber und `node:child_process` hinter sich her — ein Import von dort in eine
 * Client-Komponente fällt nicht beim Typecheck auf, sondern erst im Build als
 * `Module not found: Can't resolve 'net'`. Diese Datei hat außer einem reinen
 * Typ gar keine Importe und ist deshalb der eine Ort, den beide Seiten lesen
 * dürfen. `stats-collect.ts` reicht ihn weiter, damit der Scheduler ihn dort
 * findet, wo der Rest seiner Erfassung steht.
 *
 * Eine Minute und nicht fünf. Für fünf spräche: ein Anfragenaufkommen ist eine
 * Summe und verliert beim Zusammenfassen nichts. Das stimmt für die Summe und
 * nicht für die Form — eine Lastspitze über drei Minuten ist in einem
 * Fünf-Minuten-Fenster kein Ausschlag mehr, sondern ein etwas höherer Wert.
 */
export const HAPROXY_METRICS_INTERVAL_MS = 60_000;


/**
 * Zeitraum → Rasterweite. Ziel sind grob 150 bis 200 Punkte.
 *
 * Die Stufen folgen dem Minutentakt der Erfassung: ein gröberes Raster würfe
 * den größten Teil der Messungen weg. Feiner geht trotzdem nicht beliebig
 * — unterhalb von rund zweihundert Punkten je Reihe zeichnet Recharts mehr
 * Stützstellen, als die Kachel Pixel hat, und die Kurve wird nicht genauer,
 * sondern nur langsamer.
 */
export function bucketMs(hours: number): number {
  if (hours <= 3) return 60_000;
  if (hours <= 6) return 2 * 60_000;
  if (hours <= 24) return 10 * 60_000;
  if (hours <= 24 * 3) return 30 * 60_000;
  if (hours <= 24 * 14) return 2 * 60 * 60_000;
  return 12 * 60 * 60_000;
}

/**
 * Drei Arten, Werte zusammenzufassen — und keine davon ist der Mittelwert über
 * alle Zeilen.
 *
 * In einem Raster-Fenster liegen mehrere Zeitpunkte **und** mehrere Abschnitte.
 * Was das zusammenfassen darf, hängt daran, was die Zahl bedeutet:
 *
 *  - `SUMMED` sind Mengen im Fenster (Anfragen, Bytes, Fehler). Sie werden über
 *    alles addiert, Zeitpunkte wie Abschnitte.
 *  - `GAUGE` sind Momentanwerte (gleichzeitige Sitzungen). Über die Abschnitte
 *    eines Zeitpunkts gehören sie **addiert** — vier Sitzungen hier und drei
 *    dort sind sieben gleichzeitige. Über die Zeitpunkte gehören sie
 *    **gemittelt**: aufaddiert käme heraus, dass eine Stunde mit zwölf Proben
 *    zwölfmal so voll ist wie eine mit einer.
 *  - `WEIGHTED` sind selbst schon Mittelwerte (HAProxys `rtime` ist das Mittel
 *    über die letzten 1024 Antworten). Sie werden mit den Anfragen der Zeile
 *    gewichtet. Ungewichtet zöge ein Backend mit drei Anfragen und 900 ms die
 *    Kurve genauso weit hoch wie eines mit zehntausend und 40 ms.
 */
export const SUMMED = [
  'requests', 'http2xx', 'http3xx', 'http4xx', 'http5xx', 'httpOther',
  'denied', 'errors', 'retries', 'bytesInKb', 'bytesOutKb',
] as const;
export const GAUGE = ['sessionsCurrent', 'sessionsMax'] as const;
export const WEIGHTED = ['responseMs', 'totalMs', 'queueMs'] as const;

export type MetricField = (typeof SUMMED)[number] | (typeof GAUGE)[number] | (typeof WEIGHTED)[number];
export type Point = { at: string } & Partial<Record<MetricField, number | null>>;

/**
 * Zeilen in ein Raster.
 *
 * Ein Feld bleibt `null`, wenn im ganzen Fenster kein einziger Wert dafür
 * bekannt war. Das ist der Unterschied zwischen „in dieser Stunde kam nichts"
 * und „in dieser Stunde haben wir nicht gemessen", und die Kurve lässt die
 * Lücke aus, statt auf 0 zu fallen.
 */
export function bucketise(rows: HaproxyMetric[], width: number): Point[] {
  interface Bucket {
    sums: Map<string, number>;
    /** Je Zeitpunkt die Summe über die Abschnitte, siehe `GAUGE`. */
    gauges: Map<string, Map<string, number>>;
    weighted: Map<string, { top: number; bottom: number }>;
  }
  const buckets = new Map<number, Bucket>();

  for (const row of rows) {
    const at = Date.parse(row.collectedAt);
    if (!Number.isFinite(at)) continue;
    const slot = Math.floor(at / width) * width;
    let bucket = buckets.get(slot);
    if (!bucket) {
      bucket = { sums: new Map(), gauges: new Map(), weighted: new Map() };
      buckets.set(slot, bucket);
    }

    for (const field of SUMMED) {
      const value = row[field];
      if (value === null || value === undefined) continue;
      bucket.sums.set(field, (bucket.sums.get(field) ?? 0) + value);
    }

    for (const field of GAUGE) {
      const value = row[field];
      if (value === null || value === undefined) continue;
      let perTime = bucket.gauges.get(field);
      if (!perTime) {
        perTime = new Map();
        bucket.gauges.set(field, perTime);
      }
      perTime.set(row.collectedAt, (perTime.get(row.collectedAt) ?? 0) + value);
    }

    for (const field of WEIGHTED) {
      const value = row[field];
      if (value === null || value === undefined) continue;
      // Ohne bekannte Anfragen zählt die Zeile einfach — besser ein
      // ungewichteter Beitrag als gar keiner.
      const weight = row.requests ?? 1;
      const acc = bucket.weighted.get(field) ?? { top: 0, bottom: 0 };
      acc.top += value * weight;
      acc.bottom += weight;
      bucket.weighted.set(field, acc);
    }
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([slot, bucket]) => {
      const point: Point = { at: new Date(slot).toISOString() };
      for (const field of SUMMED) {
        point[field] = bucket.sums.has(field) ? bucket.sums.get(field)! : null;
      }
      for (const field of GAUGE) {
        const perTime = bucket.gauges.get(field);
        point[field] = perTime
          ? Math.round([...perTime.values()].reduce((a, b) => a + b, 0) / perTime.size)
          : null;
      }
      for (const field of WEIGHTED) {
        const acc = bucket.weighted.get(field);
        // Ein Fenster, in dem alle Gewichte 0 sind (keine Anfrage), hat keine
        // Antwortzeit — und nicht die Antwortzeit 0.
        point[field] = acc && acc.bottom > 0 ? Math.round(acc.top / acc.bottom) : null;
      }
      return point;
    });
}

/**
 * Was die FRONTEND-Zeilen nicht wissen, aus den BACKEND-Zeilen nachtragen.
 *
 * Das ist der Grund, warum es diese Funktion gibt, und er steckt in `show stat`
 * selbst: **vier Spalten sind reine Backend-Spalten.** `qtime`, `ctime`, `rtime`
 * und `ttime` stehen in einer FRONTEND-Zeile leer, ebenso `wretr`/`wredis` —
 * ein Frontend misst keine Antwortzeit, weil es kein Ziel hat, und es wiederholt
 * nichts. Die Übersicht liest aber die Frontends, und damit blieben zwei
 * Diagramme für immer leer, ohne dass irgendwo stünde, warum.
 *
 * Also werden genau diese Felder aus den Backends dazugelegt. Die
 * **Flussgrößen** (Anfragen, Statusklassen, Bytes, Sitzungen) kommen weiterhin
 * ausschließlich vom Frontend — sie über die Backends zu summieren wäre falsch:
 * eine Anfrage über eine Pfad-Regel zählt in deren eigenem Backend mit, und was
 * das Frontend abweist, erreicht überhaupt keins.
 *
 * `denied` und `errors` werden **addiert** und nicht ersetzt: es sind
 * verschiedene Ereignisse. `dreq`/`ereq` fallen an der Eingangsseite an,
 * `dresp`/`econ`/`eresp` an der Zielseite. Zusammen sind sie „was ist auf dieser
 * Maschine schiefgegangen".
 */
export function foldInBackends(frontend: Point[], backend: Point[]): Point[] {
  const byTime = new Map(backend.map((point) => [point.at, point]));
  const times = new Set([...frontend.map((p) => p.at), ...byTime.keys()]);
  const frontendByTime = new Map(frontend.map((point) => [point.at, point]));

  return [...times]
    .sort()
    .map((at) => {
      const front = frontendByTime.get(at) ?? { at };
      const back = byTime.get(at);
      if (!back) return front;
      return {
        ...front,
        retries: back.retries ?? null,
        responseMs: back.responseMs ?? null,
        totalMs: back.totalMs ?? null,
        queueMs: back.queueMs ?? null,
        denied: add(front.denied, back.denied),
        errors: add(front.errors, back.errors),
      };
    });
}

/** Zwei Zahlen, von denen jede unbekannt sein darf. Beide unbekannt bleibt
 *  unbekannt — eine Summe aus nichts ist keine Null. */
function add(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return a + b;
}


/** Die Summe über den ganzen Zeitraum. `null` bleibt `null`: eine Summe aus
 *  lauter Unbekanntem ist keine Null. */
export function sumUp(series: Point[]): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  const known = (field: MetricField) =>
    series.map((point) => point[field]).filter((value): value is number => typeof value === 'number');

  for (const field of SUMMED) {
    const values = known(field);
    out[field] = values.length === 0 ? null : values.reduce((a, b) => a + b, 0);
  }
  for (const field of [...GAUGE, ...WEIGHTED]) {
    const values = known(field);
    out[field] =
      values.length === 0 ? null : Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  }
  return out;
}
