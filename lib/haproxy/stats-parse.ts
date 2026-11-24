/**
 * Was HAProxy über sich selbst weiß, und wie daraus ein Balken wird.
 *
 * `show stat` über den Stats-Socket ist die Analysefunktion, die HAProxy
 * mitbringt: eine CSV mit einer Zeile je Server, dazu je eine Sammelzeile
 * `FRONTEND` und `BACKEND` pro Abschnitt. Darin stehen Anfragen, Statusklassen,
 * übertragene Bytes, Antwortzeiten, Fehler und Wiederholungen. Für die
 * Statistik-Seite ist das die Quelle — nicht das Access-Log, das nur die Frage
 * „wer" beantwortet (siehe `./access-log.ts`).
 *
 * ── Warum das die zweite Stelle ist, die diese CSV liest ──
 *
 * Es gibt sie schon einmal, absichtlich schmal: `parseStatsCsv` in
 * `./config.ts` liest **nur** `status` je Server. Sie beantwortet „leuchtet
 * die Karte grün", wirft die Sammelzeilen weg und hat Tests, die genau darauf
 * bestehen.
 *
 * Diese Datei ist die allgemeine: jede Zeile, jede Spalte, die hier gebraucht
 * wird. Sie ersetzt die andere nicht, weil deren Aufrufer weniger will und
 * ihre Tests auf dem Weniger bestehen; ein Parser, der je nach Aufrufer etwas
 * anderes zurückgibt, ist der Anfang davon, dass eine der Bedeutungen an der
 * falschen Stelle landet.
 *
 * **Beide lesen die Spalten über die Kopfzeile und nie über ihre Nummer.**
 * Das ist die eine Regel, die sie teilen, und der Grund dafür ist immer
 * derselbe: HAProxy hängt zwischen den Versionen Spalten an. 2.8 hat rund
 * dreißig mehr als 2.4, und `rtime` steht in beiden woanders. Eine feste Nummer
 * läse auf der neueren Version irgendeine andere Zahl und meldete sie als
 * Antwortzeit — auffallen würde das nie, weil eine plausible Zahl herauskommt.
 *
 * Rein und ohne einen einzigen Import: die Grenzfälle sind prüfbar, ohne dass
 * ein Proxy läuft — der Reload (Zähler springen zurück), die ausgefallene
 * Runde, die Version ohne `hrsp_other`.
 */

/* ══════════════════════════════════════════════════════════════════════
 * Die Zeilen
 * ══════════════════════════════════════════════════════════════════════ */

/** Welche Sorte Zeile das ist. Die Server-Zeilen interessieren hier nicht —
 *  ihr Zustand steht in `parseStatsCsv`, ihre Zahlen sind in der BACKEND-Zeile
 *  ihres Abschnitts schon zusammengefasst. */
export type StatKind = 'frontend' | 'backend';

/**
 * Die Zählerstände eines Abschnitts.
 *
 * Jeder Wert `number | null`, und `null` heißt **die Spalte gibt es nicht**.
 * Eine ältere HAProxy-Version kennt `hrsp_other` nicht, und ein Frontend führt
 * keine Warteschlange. Als 0 gelesen stünde da „null Anfragen dieser Art" statt
 * „diese Version sagt dazu nichts".
 */
export interface StatCounters {
  /** `pxname` — der Name des Abschnitts. Beim Reverse-Proxy-Eintrag die Dienst-ID. */
  scope: string;
  kind: StatKind;

  /**
   * Anfragen seit dem Start des Prozesses.
   *
   * `req_tot`, und nur ersatzweise `stot`. Der Unterschied ist HTTP gegen TCP:
   * eine Verbindung mit Keep-Alive trägt viele Anfragen, `stot` zählt sie als
   * eine. Für einen `listen`-Abschnitt in `mode tcp` gibt es `req_tot` gar
   * nicht, und dort ist die Sitzung tatsächlich die Einheit.
   */
  requests: number | null;
  /** `stot` — Sitzungen, unabhängig davon, was oben gewonnen hat. */
  sessions: number | null;

  http2xx: number | null;
  http3xx: number | null;
  http4xx: number | null;
  http5xx: number | null;
  /** `hrsp_1xx` und `hrsp_other` zusammen: alles, was in keine Klasse fällt. */
  httpOther: number | null;

  /** `bin` / `bout` — übertragene Bytes seit dem Start. */
  bytesIn: number | null;
  bytesOut: number | null;

  /** `dreq` + `dresp` — von einer Regel abgewiesen (Admin-IP-Sperre, Sperrliste). */
  denied: number | null;
  /** `ereq` + `econ` + `eresp` — Anfrage-, Verbindungs- und Antwortfehler. */
  errors: number | null;
  /** `wretr` + `wredis` — Wiederholungen und Umleitungen auf ein anderes Ziel. */
  retries: number | null;

  /**
   * `rtime`, `ttime`, `qtime` in Millisekunden.
   *
   * **Keine Zähler**, sondern gleitende Mittelwerte über die letzten 1024
   * Antworten. Sie werden übernommen und nicht differenziert — die Differenz
   * zweier Mittelwerte ist eine Zahl ohne Bedeutung.
   */
  responseMs: number | null;
  totalMs: number | null;
  queueMs: number | null;

  /** `scur` / `smax` — Momentanwerte zum Zeitpunkt der Probe. */
  sessionsCurrent: number | null;
  sessionsMax: number | null;
}

/**
 * Die Sammelzeilen einer `show stat`-Ausgabe.
 *
 * Zurück kommen genau die beiden Zeilen, die `parseStatsCsv` wegwirft:
 * `FRONTEND` und `BACKEND`. Die Server-Zeilen bleiben draußen, weil ihre Zahlen
 * in der BACKEND-Zeile ihres Abschnitts schon enthalten sind — mitgezählt wäre
 * jede Anfrage doppelt in der Summe.
 *
 * Ein `listen`-Abschnitt (die TCP-Weiterleitungen) taucht mit **beiden**
 * Sammelzeilen auf, unter demselben Namen. Das ist kein Sonderfall, sondern
 * genau die Trennung, die `kind` trägt.
 */
export function parseStatRows(csv: string): StatCounters[] {
  const lines = csv.split('\n').filter((line) => line.trim() !== '');
  const header = lines.find((line) => line.startsWith('#'));
  if (!header) return [];

  const columns = header.replace(/^#\s*/, '').split(',');
  const at = (name: string) => columns.indexOf(name);

  const px = at('pxname');
  const sv = at('svname');
  if (px === -1 || sv === -1) return [];

  const index = {
    reqTot: at('req_tot'),
    stot: at('stot'),
    h1: at('hrsp_1xx'),
    h2: at('hrsp_2xx'),
    h3: at('hrsp_3xx'),
    h4: at('hrsp_4xx'),
    h5: at('hrsp_5xx'),
    hOther: at('hrsp_other'),
    bin: at('bin'),
    bout: at('bout'),
    dreq: at('dreq'),
    dresp: at('dresp'),
    ereq: at('ereq'),
    econ: at('econ'),
    eresp: at('eresp'),
    wretr: at('wretr'),
    wredis: at('wredis'),
    rtime: at('rtime'),
    ttime: at('ttime'),
    qtime: at('qtime'),
    scur: at('scur'),
    smax: at('smax'),
  };

  const out: StatCounters[] = [];
  for (const line of lines) {
    if (line.startsWith('#')) continue;
    const cells = line.split(',');

    const marker = cells[sv];
    const kind: StatKind | null =
      marker === 'FRONTEND' ? 'frontend' : marker === 'BACKEND' ? 'backend' : null;
    if (!kind) continue;

    const scope = cells[px];
    if (!scope) continue;

    const cell = (position: number) => (position < 0 ? null : toNumber(cells[position]));
    const sessions = cell(index.stot);
    const requests = cell(index.reqTot);

    out.push({
      scope,
      kind,
      // `req_tot` kann 0 sein und trotzdem stimmen (ein TCP-Abschnitt): dann
      // zählt die Sitzung. Deshalb `null`-Prüfung und nicht `||`.
      requests: requests === null ? sessions : requests,
      sessions,
      http2xx: cell(index.h2),
      http3xx: cell(index.h3),
      http4xx: cell(index.h4),
      http5xx: cell(index.h5),
      httpOther: addUp([cell(index.h1), cell(index.hOther)]),
      bytesIn: cell(index.bin),
      bytesOut: cell(index.bout),
      denied: addUp([cell(index.dreq), cell(index.dresp)]),
      errors: addUp([cell(index.ereq), cell(index.econ), cell(index.eresp)]),
      retries: addUp([cell(index.wretr), cell(index.wredis)]),
      responseMs: cell(index.rtime),
      totalMs: cell(index.ttime),
      queueMs: cell(index.qtime),
      sessionsCurrent: cell(index.scur),
      sessionsMax: cell(index.smax),
    });
  }
  return out;
}

/**
 * Mehrere Spalten zu einer Zahl.
 *
 * Fehlt jede von ihnen, ist das Ergebnis `null` und nicht 0 — dieselbe Regel
 * wie überall. Fehlt nur eine, zählen die übrigen: eine Version ohne
 * `hrsp_other` weiß trotzdem, wie viele `1xx` es gab.
 */
function addUp(values: (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0);
}

/** Was keine endliche Zahl ist, ist unbekannt — nicht 0. */
function toNumber(value: string | undefined): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/* ══════════════════════════════════════════════════════════════════════
 * `show info`: der Prozess selbst
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * Was über HAProxy als Prozess bekannt ist.
 *
 * Zwei Werte davon stehen in keiner Statistikzeile und beantworten trotzdem die
 * erste Frage, die man auf einer Auswertung hat: `uptimeSec` sagt, über welchen
 * Zeitraum die Zähler überhaupt laufen — ein Proxy, der vor zehn Minuten neu
 * geladen wurde, hat kleine Zahlen, weil er neu ist und nicht, weil nichts los
 * ist. Und `idlePct` sagt, ob noch Luft ist.
 */
export interface ProcessInfo {
  version: string | null;
  uptimeSec: number | null;
  /** `CumReq` — Anfragen seit dem Start, über alle Abschnitte. */
  cumulativeRequests: number | null;
  currentConnections: number | null;
  connectionRate: number | null;
  sslRate: number | null;
  /** `Idle_pct` — wie viel Leerlauf der Prozess noch hat. */
  idlePct: number | null;
  maxConnections: number | null;
}

/** `show info` liefert `Name: Wert` je Zeile. */
export function parseProcessInfo(text: string): ProcessInfo {
  const values = new Map<string, string>();
  for (const line of text.split('\n')) {
    const cut = line.indexOf(':');
    if (cut < 1) continue;
    values.set(line.slice(0, cut).trim(), line.slice(cut + 1).trim());
  }
  const num = (key: string) => toNumber(values.get(key));

  return {
    version: values.get('Version') ?? null,
    uptimeSec: num('Uptime_sec'),
    cumulativeRequests: num('CumReq'),
    currentConnections: num('CurrConns'),
    connectionRate: num('ConnRate'),
    sslRate: num('SslRate'),
    idlePct: num('Idle_pct'),
    maxConnections: num('Maxconn'),
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * Differenzbildung
 * ══════════════════════════════════════════════════════════════════════
 *
 * `show stat` liefert Zähler seit dem Start des Prozesses, kein Fenster. Ein
 * Balken ist immer die Differenz zweier Stände.
 *
 * Die Konsequenz: die **erste** Probe nach dem Start von HAPM hat keine
 * Vorgängerin und liefert `null`, nicht 0. Ein Balken der Höhe null behauptet
 * „in diesem Fenster kam keine einzige Anfrage" — die Wahrheit ist „wir wissen
 * es nicht".
 */

/**
 * Ab wann die Differenz keine Aussage über EIN Fenster mehr ist.
 *
 * Fünf Minuten, also fünf Takte. Stand HAPM
 * dazwischen, ergäbe die nächste Probe eine saubere Summe über die ganze
 * Auszeit — nur würde die als EIN Punkt gezeichnet und stünde als Spitze da,
 * die es nie gab.
 */
export const MAX_GAP_MS = 5 * 60_000;

/** Kürzer als das ist kein Fenster: zwei Proben in derselben Sekunde messen nichts. */
const MIN_GAP_MS = 10_000;

export interface StatSnapshot {
  /** Millisekunden seit Epoch. */
  at: number;
  counters: StatCounters;
  /**
   * Die Laufzeit des Prozesses zum Zeitpunkt der Probe.
   *
   * Sie ist der **verlässliche** Reload-Nachweis. Ein Rücksprung im Zähler
   * fällt nur auf, wenn danach weniger dasteht als vorher; wird zwischen zwei
   * Proben neu geladen **und** kommen dann mehr Anfragen als vorher gezählt
   * waren, sähe die Differenz plausibel aus und wäre trotzdem falsch. Die
   * Laufzeit verrät den Neustart in beiden Fällen — dieselbe Rolle wie
   * `stats_reset` bei `pg_stat_database`.
   */
  uptimeSec: number | null;
}

/** Taugt der Abstand zweier Proben als Fenster? `null` heißt: keine Aussage. */
export function usableGap(previous: { at: number } | null, currentAt: number): number | null {
  if (!previous) return null;
  const elapsed = currentAt - previous.at;
  if (elapsed < MIN_GAP_MS || elapsed > MAX_GAP_MS) return null;
  return elapsed;
}

/**
 * Zählerdifferenz, oder `null` bei Rücksprung.
 *
 * Der Rücksprung ist der Regelfall und kein Sonderfall: HAProxy wird bei jedem
 * Zertifikatswechsel und jeder Änderung an einem Dienst neu geladen. Danach
 * stehen die Zähler wieder bei null, und `aktuell - vorher` wäre eine große
 * negative Zahl. Sie auf 0 zu klemmen wäre schlechter als `null`: 0 heißt
 * „nichts passiert", `null` heißt „diesen einen Balken kennen wir nicht".
 */
export function counterDelta(previous: number | null, current: number | null): number | null {
  if (previous === null || current === null) return null;
  const delta = current - previous;
  return delta < 0 ? null : delta;
}

/** Was in einer Zeile der Zeitreihe steht. */
export interface StatRates {
  requests: number | null;
  http2xx: number | null;
  http3xx: number | null;
  http4xx: number | null;
  http5xx: number | null;
  httpOther: number | null;
  denied: number | null;
  errors: number | null;
  retries: number | null;
  bytesInKb: number | null;
  bytesOutKb: number | null;
  responseMs: number | null;
  totalMs: number | null;
  queueMs: number | null;
  sessionsCurrent: number | null;
  sessionsMax: number | null;
}

/**
 * Zwei Proben zu einer Zeile.
 *
 * Ein Neustart des Prozesses dazwischen macht **jede** Differenz falsch, auch
 * die, die positiv aussieht — siehe `StatSnapshot.uptimeSec`.
 */
export function statRates(previous: StatSnapshot | null, current: StatSnapshot): StatRates {
  const inWindow = usableGap(previous, current.at) === null ? null : previous;
  const restarted =
    inWindow !== null &&
    inWindow.uptimeSec !== null &&
    current.uptimeSec !== null &&
    current.uptimeSec < inWindow.uptimeSec;
  const usable = inWindow !== null && !restarted ? inWindow.counters : null;

  const delta = (pick: (counters: StatCounters) => number | null) =>
    usable === null ? null : counterDelta(pick(usable), pick(current.counters));

  return {
    requests: delta((c) => c.requests),
    http2xx: delta((c) => c.http2xx),
    http3xx: delta((c) => c.http3xx),
    http4xx: delta((c) => c.http4xx),
    http5xx: delta((c) => c.http5xx),
    httpOther: delta((c) => c.httpOther),
    denied: delta((c) => c.denied),
    errors: delta((c) => c.errors),
    retries: delta((c) => c.retries),
    bytesInKb: toKb(delta((c) => c.bytesIn)),
    bytesOutKb: toKb(delta((c) => c.bytesOut)),
    // Die Mittelwerte und Momentanwerte stehen auch ohne Vorgängerin: sie sind
    // die einzigen Werte dieser Zeile, die schon aus einer Probe stimmen.
    responseMs: rounded(current.counters.responseMs),
    totalMs: rounded(current.counters.totalMs),
    queueMs: rounded(current.counters.queueMs),
    sessionsCurrent: current.counters.sessionsCurrent,
    sessionsMax: current.counters.sessionsMax,
  };
}

/**
 * Hat diese Probe überhaupt etwas zu sagen?
 *
 * Eine Zeile, in der jeder Wert unbekannt ist, ist keine Messung — sie ist eine
 * Zeile. Sie zu schreiben hieße, eine Lücke als Datenpunkt auszugeben.
 */
export function hasMeasurement(rates: StatRates): boolean {
  return Object.values(rates).some((value) => value !== null);
}

function toKb(bytes: number | null): number | null {
  return bytes === null ? null : Math.round(bytes / 1024);
}

function rounded(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}
