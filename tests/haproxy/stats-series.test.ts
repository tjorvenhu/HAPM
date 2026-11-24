import { describe, it, expect } from 'vitest';
import {
  bucketMs,
  bucketise,
  foldInBackends,
  sumUp,
} from '@/lib/haproxy/stats-series';
import type { HaproxyMetric } from '@/lib/types';

/**
 * Aus Messzeilen werden Diagrammpunkte.
 *
 * Der Test ist da, weil beim ersten Anlauf genau hier zwei Fehler standen, die
 * eine Seite ergeben, die nicht kaputt aussieht, sondern falsch:
 *
 *  - Die Antwortzeiten wurden aus den FRONTEND-Zeilen genommen. `qtime`,
 *    `ctime`, `rtime` und `ttime` stehen dort aber leer — ein Frontend hat kein
 *    Ziel und misst keine Antwortzeit. Das Diagramm blieb für immer leer.
 *  - Die Mittelwerte wurden ungewichtet gemittelt. Ein Backend mit drei
 *    Anfragen und 900 ms zog die Kurve dann genauso weit hoch wie eines mit
 *    zehntausend Anfragen und 40 ms.
 */

const BASE: HaproxyMetric = {
  $id: 'x', $createdAt: '', $updatedAt: '',
  serverId: 's1', scope: 'a', kind: 'backend', collectedAt: '',
  requests: null, http2xx: null, http3xx: null, http4xx: null, http5xx: null,
  httpOther: null, denied: null, errors: null, retries: null,
  bytesInKb: null, bytesOutKb: null,
  responseMs: null, totalMs: null, queueMs: null,
  sessionsCurrent: null, sessionsMax: null,
} as HaproxyMetric;

function metric(at: string, values: Partial<HaproxyMetric>): HaproxyMetric {
  return { ...BASE, collectedAt: at, ...values };
}

const HOUR = 60 * 60_000;

describe('bucketMs', () => {
  it('wählt das Raster nach dem Zeitraum', () => {
    expect(bucketMs(3)).toBe(60_000);
    expect(bucketMs(6)).toBe(2 * 60_000);
    expect(bucketMs(24)).toBe(10 * 60_000);
    expect(bucketMs(72)).toBe(30 * 60_000);
    expect(bucketMs(720)).toBe(12 * HOUR);
  });

  it('bleibt in jeder Stufe unter rund 200 Punkten je Reihe', () => {
    // Feiner zu rastern macht die Kurve nicht genauer, sondern nur langsamer:
    // eine Kachel ist rund 900 Pixel breit.
    for (const hours of [3, 6, 24, 72, 168, 720]) {
      expect(Math.round((hours * HOUR) / bucketMs(hours))).toBeLessThanOrEqual(200);
    }
  });
});

describe('bucketise: Mengen', () => {
  it('summiert über Zeitpunkte UND Abschnitte', () => {
    const points = bucketise(
      [
        metric('2026-02-06T12:00:00.000Z', { scope: 'a', requests: 100 }),
        metric('2026-02-06T12:00:00.000Z', { scope: 'b', requests: 50 }),
        metric('2026-02-06T12:30:00.000Z', { scope: 'a', requests: 30 }),
      ],
      HOUR
    );
    expect(points).toHaveLength(1);
    expect(points[0].requests).toBe(180);
  });

  it('trennt die Fenster', () => {
    const points = bucketise(
      [
        metric('2026-02-06T12:59:00.000Z', { requests: 10 }),
        metric('2026-02-06T13:01:00.000Z', { requests: 20 }),
      ],
      HOUR
    );
    expect(points.map((p) => p.requests)).toEqual([10, 20]);
    expect(points[0].at).toBe('2026-02-06T12:00:00.000Z');
  });

  it('macht aus lauter Unbekanntem kein 0', () => {
    // Eine Stunde ohne Messung ist eine Lücke in der Kurve und kein Nullbalken.
    const points = bucketise([metric('2026-02-06T12:00:00.000Z', { sessionsCurrent: 3 })], HOUR);
    expect(points[0].requests).toBeNull();
    expect(points[0].bytesOutKb).toBeNull();
  });
});

describe('bucketise: Momentanwerte', () => {
  it('addiert über die Abschnitte und mittelt über die Zeitpunkte', () => {
    /*
     * Vier gleichzeitige Sitzungen hier und drei dort sind sieben gleichzeitige
     * — über die Abschnitte gehört das addiert. Über die Zeitpunkte gehört es
     * gemittelt: aufaddiert wäre eine Stunde mit zwei Proben doppelt so voll
     * wie eine mit einer.
     */
    const points = bucketise(
      [
        metric('2026-02-06T12:00:00.000Z', { scope: 'a', sessionsCurrent: 4 }),
        metric('2026-02-06T12:00:00.000Z', { scope: 'b', sessionsCurrent: 3 }),
        metric('2026-02-06T12:30:00.000Z', { scope: 'a', sessionsCurrent: 1 }),
      ],
      HOUR
    );
    // (4 + 3) und 1, gemittelt über zwei Zeitpunkte.
    expect(points[0].sessionsCurrent).toBe(4);
  });
});

describe('bucketise: Mittelwerte', () => {
  it('gewichtet die Antwortzeit mit den Anfragen', () => {
    const points = bucketise(
      [
        metric('2026-02-06T12:00:00.000Z', { scope: 'gross', requests: 10_000, responseMs: 40 }),
        metric('2026-02-06T12:00:00.000Z', { scope: 'klein', requests: 3, responseMs: 900 }),
      ],
      HOUR
    );
    // Ungewichtet wären es 470 ms — eine Zahl, die für keinen der beiden
    // Dienste stimmt und für die Maschine erst recht nicht.
    expect(points[0].responseMs).toBe(40);
  });

  it('ohne bekannte Anfragen zählt die Zeile einfach', () => {
    const points = bucketise(
      [
        metric('2026-02-06T12:00:00.000Z', { scope: 'a', responseMs: 100 }),
        metric('2026-02-06T12:00:00.000Z', { scope: 'b', responseMs: 200 }),
      ],
      HOUR
    );
    expect(points[0].responseMs).toBe(150);
  });

  it('ein Fenster ohne eine einzige Anfrage hat keine Antwortzeit', () => {
    // Und nicht die Antwortzeit 0: durch null geteilt wäre hier eine erfundene
    // Zahl entstanden.
    const points = bucketise(
      [metric('2026-02-06T12:00:00.000Z', { requests: 0, responseMs: 87 })],
      HOUR
    );
    expect(points[0].responseMs).toBeNull();
  });
});

describe('foldInBackends', () => {
  const frontend = bucketise(
    [
      metric('2026-02-06T12:00:00.000Z', {
        kind: 'frontend', requests: 500, denied: 4, errors: 1,
        sessionsCurrent: 12, responseMs: null, retries: null,
      }),
    ],
    HOUR
  );
  const backend = bucketise(
    [
      metric('2026-02-06T12:00:00.000Z', {
        kind: 'backend', requests: 480, denied: 2, errors: 3,
        responseMs: 87, totalMs: 91, queueMs: 0, retries: 6,
      }),
    ],
    HOUR
  );
  const merged = foldInBackends(frontend, backend);

  it('trägt die reinen Backend-Spalten nach', () => {
    // Der Fehler, wegen dem es diese Funktion gibt: ohne sie blieben
    // Antwortzeiten und Wiederholungen in der Übersicht für immer leer.
    expect(merged[0].responseMs).toBe(87);
    expect(merged[0].totalMs).toBe(91);
    expect(merged[0].queueMs).toBe(0);
    expect(merged[0].retries).toBe(6);
  });

  it('lässt die Flussgrößen beim Frontend', () => {
    // Die Backends aufzusummieren wäre falsch: eine Anfrage über eine
    // Pfad-Regel zählt in deren eigenem Backend mit.
    expect(merged[0].requests).toBe(500);
    expect(merged[0].sessionsCurrent).toBe(12);
  });

  it('addiert Fehler und Abweisungen beider Seiten', () => {
    // dreq/ereq an der Eingangsseite, dresp/econ/eresp an der Zielseite — das
    // sind verschiedene Ereignisse, keine doppelte Zählung.
    expect(merged[0].denied).toBe(6);
    expect(merged[0].errors).toBe(4);
  });

  it('behält einen Zeitpunkt, den nur eine Seite kennt', () => {
    const only = foldInBackends(frontend, []);
    expect(only).toHaveLength(1);
    expect(only[0].requests).toBe(500);
    expect(only[0].retries ?? null).toBeNull();
  });
});

describe('sumUp', () => {
  it('summiert Mengen und mittelt Mittelwerte', () => {
    const totals = sumUp([
      { at: 'a', requests: 100, responseMs: 40, sessionsCurrent: 2 },
      { at: 'b', requests: 200, responseMs: 60, sessionsCurrent: 4 },
    ]);
    expect(totals.requests).toBe(300);
    expect(totals.responseMs).toBe(50);
    expect(totals.sessionsCurrent).toBe(3);
  });

  it('eine Summe aus lauter Unbekanntem ist keine Null', () => {
    const totals = sumUp([{ at: 'a', requests: null }]);
    expect(totals.requests).toBeNull();
    expect(totals.responseMs).toBeNull();
  });
});
