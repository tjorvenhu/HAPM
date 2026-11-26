/**
 * Wer zugreift — die Frage, die `show stat` nicht beantwortet.
 *
 * Die Zeitreihe in `./stats-parse.ts` weiß, WIE VIEL über einen Dienst lief.
 * Sie weiß nicht, von welchen Adressen, aus welchen Ländern und auf welche
 * Pfade: HAProxy führt darüber keine Zähler. Das steht ausschließlich im
 * Access-Log, eine Zeile je Anfrage.
 *
 * ── Warum auf der Maschine gerechnet wird und nicht hier ──
 *
 * Ein Proxy mit ein paar belebten Seiten schreibt am Tag Millionen Zeilen. Sie
 * ganz in den Node-Prozess zu lesen und dort zu zählen wären Hunderte Megabyte
 * für ein Ergebnis von zwei Kilobyte. Also läuft ein `awk` über die Datei und
 * gibt die fertigen Summen zurück — dieselbe Überlegung wie bei `ss -Hltn` in
 * `./streams.ts`: die Frage dort beantworten, wo die Daten liegen.
 *
 * ── Warum das Fenster über `tail` geht und nicht über das Datum ──
 *
 * Weil nur so vorher feststeht, was der Lauf kostet. Ein Filter „seit gestern"
 * liest die Datei trotzdem ganz und dauert auf einer belebten Maschine
 * beliebig lange; `tail -n` ist eine feste Obergrenze an Arbeit und Speicher.
 * Der Preis ist, dass das Fenster nicht rund ist — und genau deshalb sagt das
 * Ergebnis, welchen Zeitraum es tatsächlich abdeckt (`from`/`to`), statt eine
 * Überschrift zu tragen, die es nicht einlöst.
 *
 * ── Was hier NICHT passiert ──
 *
 * Diese Datei redet mit niemandem. Sie baut Kommandos und liest deren Ausgabe,
 * ohne einen Import außer `../shell` — damit sich jeder Grenzfall prüfen lässt,
 * ohne dass ein Proxy läuft: das leere Log, die Zeile ohne Backend, die
 * IPv6-Adresse mit Port, das Log in einem anderen Format.
 */

import { shellEscape } from '../shell';
import { msgid } from '../i18n/translate';

/* ══════════════════════════════════════════════════════════════════════
 * Wo das Log liegt
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * Die Stellen, an denen ein HAProxy-Log liegt.
 *
 * Eine feste Liste und keine Suche über das Dateisystem: `find /var/log` auf
 * einer Maschine mit vielen Diensten ist teuer, und was dabei herauskäme, wäre
 * nicht unbedingt HAProxys Log. Die vier Pfade sind die, die rsyslog- und
 * Distributionspakete anlegen.
 *
 * Der Pfad geht in ein Kommando, das als root läuft. Er kommt deshalb **aus
 * dieser Liste** und nie aus einer Eingabe — dieselbe Bauweise wie die
 * Anbieter-Allow-Liste in `./dns-credentials.ts`.
 */
export const LOG_CANDIDATES = [
  '/var/log/haproxy.log',
  '/var/log/haproxy/haproxy.log',
  '/var/log/haproxy/access.log',
  '/var/log/haproxy/haproxy-traffic.log',
] as const;

export type LogCandidate = (typeof LOG_CANDIDATES)[number];

/** Woraus gelesen wird. `journal` ist der Weg ohne rsyslog. */
export type LogSource =
  | { kind: 'file'; path: LogCandidate }
  | { kind: 'journal' }
  | { kind: 'none' };

/**
 * Welche der Kandidaten es gibt, und ob journald etwas hat.
 *
 * Ein Kommando für beides. `-s` statt `-f`: eine
 * Datei, die es gibt, aber leer ist, ist keine Quelle — sie wäre sonst „null
 * Anfragen" statt „hier steht nichts drin".
 */
export function discoverCommand(): string {
  const checks = LOG_CANDIDATES.map(
    (path) => `if [ -s ${shellEscape(path)} ]; then printf 'file %s\\n' ${shellEscape(path)}; fi`
  ).join('; ');
  // `-n 1` reicht: gefragt ist, ob die Unit überhaupt protokolliert.
  return (
    `${checks}; ` +
    `if command -v journalctl >/dev/null 2>&1 && ` +
    `journalctl -u haproxy -n 1 --no-pager -q 2>/dev/null | grep -q .; then ` +
    `printf 'journal\\n'; fi; true`
  );
}

/**
 * Die erste brauchbare Quelle.
 *
 * Die Reihenfolge ist die der Liste, journald zuletzt: eine Datei lässt sich
 * mit `tail` in fester Zeit anfassen, `journalctl` muss den Ringpuffer
 * durchgehen. Und ein Rückgabewert `none` heißt **unbekannt** und nicht „kein
 * Verkehr" — die Oberfläche sagt dann, dass kein Log gefunden wurde, statt eine
 * Null anzuzeigen.
 */
export function parseDiscovery(stdout: string): LogSource {
  const lines = stdout.split('\n').map((line) => line.trim());
  for (const candidate of LOG_CANDIDATES) {
    if (lines.includes(`file ${candidate}`)) return { kind: 'file', path: candidate };
  }
  if (lines.includes('journal')) return { kind: 'journal' };
  return { kind: 'none' };
}

/* ══════════════════════════════════════════════════════════════════════
 * Die Auswertung
 * ══════════════════════════════════════════════════════════════════════ */

/** Wie viele Zeilen ein Lauf höchstens ansieht. */
export const DEFAULT_LINE_LIMIT = 200_000;
export const MAX_LINE_LIMIT = 2_000_000;

/**
 * Wie viele Adressen und Pfade zurückkommen.
 *
 * Die 3000 sind nicht für die Anzeige — dort stehen fünfzig. Sie sind für die
 * Länder: die Verteilung wird aus diesen Adressen gerechnet, und je mehr davon
 * mitkommen, desto größer der Anteil der Anfragen, den sie abdeckt. Wie groß
 * er tatsächlich ist, sagt die Auswertung selbst (`countryCoverage`), statt
 * eine Verteilung als vollständig auszugeben, die es nicht ist.
 */
const IP_LIMIT = 3000;
const PATH_LIMIT = 100;

const MARK_IPS = '__HAPM_IPS__';
const MARK_PATHS = '__HAPM_PATHS__';

/**
 * Das awk-Programm.
 *
 * ── Warum die Felder gesucht und nicht gezählt werden ──
 *
 * Vor der eigentlichen Zeile steht ein syslog-Kopf, und der ist nicht überall
 * gleich lang: mal mit Hostname, mal mit Prozess-ID, bei journald ganz anders.
 * Eine feste Feldnummer läse deshalb auf der einen Maschine den Statuscode und
 * auf der nächsten die Bytes. Gesucht wird stattdessen das Feld, das mit `[`
 * anfängt — das Annahmedatum, das es in jeder Fassung von `option httplog`
 * genau einmal gibt. Alles andere hat einen festen Abstand dazu.
 *
 * ── Warum die Adresse von RECHTS getrennt wird ──
 *
 * HAProxy schreibt `%ci:%cp`, und bei IPv6 ist das `2001:db8::1:54321` — die
 * Adresse enthält selbst Doppelpunkte. Von links getrennt käme `2001` heraus.
 * Der Port steht immer am Ende, also wird er dort abgeschnitten.
 *
 * ── Warum Adressen und Pfade in Dateien gehen ──
 *
 * Sortiert wird mit `sort`, nicht in awk: `asort` gibt es nur in gawk, und auf
 * Debian ist `awk` ein mawk. Ein Programm, das je nach Abbild still nichts
 * liefert, ist keine Auswertung.
 *
 * ── Warum die Zeiten geprüft werden ──
 *
 * Eine TCP-Weiterleitung schreibt mit `option tcplog` in dieselbe Datei. Ihre
 * Zeile hat an der Stelle des Statuscodes die Bytes: als Anfrage gezählt, stünde
 * dort „Status 51234". Eine HTTP-Zeile hat fünf Zeiten (vier Schrägstriche),
 * eine TCP-Zeile drei, und der Status ist dreistellig oder `-1`.
 *
 * ── Woher die Stunde kommt ──
 *
 * Vom Kopf der Zeile, den HAPM beim Mitschreiben davorsetzt (UTC, ISO), wo es
 * ihn gibt: die Zeit in der eckigen Klammer ist die Ortszeit des
 * HAProxy-Containers, und der läuft ohne `TZ` in UTC, der Browser aber nicht.
 * Die Kurve läge sonst ein oder zwei Stunden daneben. Für Anfang und Ende des
 * Zeitraums wird nach Jahr, Monat, Tag, Stunde verglichen (`sk`): `31/Jan`
 * gegen `01/Feb` als Text vertauschte beide.
 *
 * Enthält bewusst **kein** einfaches Anführungszeichen: es geht als ein
 * Argument durch `shellEscape`, und das ist die Sorte Zeichen, an der eine
 * Kommandozeile aufbricht.
 */
const AWK_PROGRAM = String.raw`
{
  total++
  ci = 0
  for (i = 1; i <= NF && i <= 14; i++) { if (substr($i, 1, 1) == "[") { ci = i; break } }
  if (ci < 2 || ci + 5 > NF) next

  ip = $(ci - 1)
  sub(/:[0-9]+$/, "", ip)
  if (ip == "" || ip == "-") next

  be = $(ci + 2)
  sub(/\/.*/, "", be)
  if (be == "" || be == "-") be = "(ohne Backend)"
  if (only != "" && be != only) next

  tm = $(ci + 3)
  if (gsub(/\//, "/", tm) != 4) next
  st = $(ci + 4)
  if (st !~ /^(-1|[1-5][0-9][0-9])$/) next
  by = $(ci + 5)
  if (by !~ /^[0-9]+$/) by = 0

  if ($1 ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:/) {
    when = substr($1, 1, 13)
    sk = when
  } else {
    when = substr($ci, 2, 14)
    sk = substr(when, 8, 4) sprintf("%02d", (index("JanFebMarAprMayJunJulAugSepOctNovDec", substr(when, 4, 3)) + 2) / 3) substr(when, 1, 2) substr(when, 13, 2)
  }
  if (first == "" || sk < firstKey) { first = when; firstKey = sk }
  if (last == "" || sk > lastKey) { last = when; lastKey = sk }

  parsed++
  bytes += by
  ips[ip]++
  hours[when]++
  codes[st]++

  cls = substr(st, 1, 1)
  if (cls == "2") c2[be]++
  else if (cls == "3") c3[be]++
  else if (cls == "4") c4[be]++
  else if (cls == "5") c5[be]++
  else co[be]++

  req[be]++
  beb[be] += by

  n = split($0, q, "\"")
  if (n >= 2) {
    split(q[n - 1], r, " ")
    if (r[1] != "") methods[r[1]]++
    path = r[2]
    sub(/\?.*/, "", path)
    if (path != "" && (pathCount < 20000 || path in paths)) {
      if (!(path in paths)) pathCount++
      paths[path]++
    }
  }
}
END {
  printf "T %d %d %d\n", total, parsed, bytes
  if (first != "") printf "F %s\n", first
  if (last != "") printf "L %s\n", last
  for (k in req) printf "B %d %d %d %d %d %d %d %s\n", req[k], c2[k], c3[k], c4[k], c5[k], co[k], beb[k], k
  for (k in codes) printf "S %s %d\n", k, codes[k]
  for (k in methods) printf "M %s %d\n", k, methods[k]
  for (k in hours) printf "H %s %d\n", k, hours[k]
  u = 0
  for (k in ips) { u++; printf "%d %s\n", ips[k], k > (tmp "/ip") }
  printf "U %d\n", u
  p = 0
  for (k in paths) { p++; printf "%d %s\n", paths[k], k > (tmp "/path") }
  printf "P %d\n", p
}
`;

export interface AnalyseOptions {
  source: LogSource;
  /** Nur dieses Backend. Leer heißt: alles, und dann ist die Auswertung die
   *  der ganzen Maschine. */
  backend?: string;
  lines?: number;
}

/**
 * Das Kommando für einen Auswertungslauf.
 *
 * Die einzigen veränderlichen Teile sind der Pfad (aus `LOG_CANDIDATES`, also
 * einer festen Liste), die Zeilenzahl (auf eine Ganzzahl geklemmt) und der
 * Backend-Name — und der geht über `-v`, also als awk-Variable und nicht in den
 * Programmtext. Zusammengesetzt würde er zu einem Stück awk, das jemand
 * anderes geschrieben hat.
 */
export function analyseCommand(options: AnalyseOptions): string {
  if (options.source.kind === 'none') {
    throw new Error(msgid('Es ist keine Log-Quelle bekannt.'));
  }

  const limit = Math.min(
    MAX_LINE_LIMIT,
    Math.max(1000, Math.floor(options.lines ?? DEFAULT_LINE_LIMIT))
  );

  const reader =
    options.source.kind === 'file'
      ? `tail -n ${limit} ${shellEscape(options.source.path)} 2>/dev/null`
      : `journalctl -u haproxy -n ${limit} --no-pager -q -o cat 2>/dev/null`;

  const only = options.backend ?? '';

  // Ein Verzeichnis je Lauf und `trap`, damit auch ein Abbruch nichts liegen
  // lässt. Ohne das sammelten sich auf einer Maschine, die viel ausgewertet
  // wird, Temp-Verzeichnisse an, die niemand mehr zuordnen kann.
  return (
    `d=$(mktemp -d) || exit 1; trap "rm -rf \\"$d\\"" EXIT; ` +
    `${reader} | awk -v tmp="$d" -v only=${shellEscape(only)} ${shellEscape(AWK_PROGRAM)}; ` +
    `printf '%s\\n' ${shellEscape(MARK_IPS)}; ` +
    `sort -rn -k1,1 "$d/ip" 2>/dev/null | head -n ${IP_LIMIT}; ` +
    `printf '%s\\n' ${shellEscape(MARK_PATHS)}; ` +
    `sort -rn -k1,1 "$d/path" 2>/dev/null | head -n ${PATH_LIMIT}; ` +
    `true`
  );
}

/* ══════════════════════════════════════════════════════════════════════
 * Die Ausgabe zurücklesen
 * ══════════════════════════════════════════════════════════════════════ */

export interface BackendTraffic {
  backend: string;
  requests: number;
  http2xx: number;
  http3xx: number;
  http4xx: number;
  http5xx: number;
  httpOther: number;
  bytes: number;
}

export interface Counted {
  key: string;
  count: number;
}

export interface AccessLogStats {
  /** Wie viele Zeilen angesehen wurden und wie viele davon lesbar waren. */
  lines: number;
  parsed: number;
  bytes: number;
  /** Der Zeitraum, den die angesehenen Zeilen wirklich abdecken. `null` heißt:
   *  keine lesbare Zeile — dann steht in der Oberfläche kein Zeitraum und keine
   *  erfundene Überschrift. */
  from: string | null;
  to: string | null;
  /** Wie viele verschiedene Adressen im Fenster vorkamen. Exakt, auch wenn
   *  `ips` nur die häufigsten trägt. */
  uniqueIps: number;
  /** Wie viele verschiedene Pfade. Ab 20 000 hört das Zählen auf, siehe awk. */
  uniquePaths: number;
  backends: BackendTraffic[];
  /** Die häufigsten Adressen, absteigend. */
  ips: Counted[];
  paths: Counted[];
  statusCodes: Counted[];
  methods: Counted[];
  /** Anfragen je Stunde, aufsteigend. Der Schlüssel ist ISO. */
  hours: { hour: string; count: number }[];
}

const EMPTY: AccessLogStats = {
  lines: 0,
  parsed: 0,
  bytes: 0,
  from: null,
  to: null,
  uniqueIps: 0,
  uniquePaths: 0,
  backends: [],
  ips: [],
  paths: [],
  statusCodes: [],
  methods: [],
  hours: [],
};

const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

/**
 * `06/Feb/2026:12` in `2026-02-06T12:00:00`.
 *
 * Ohne Zeitzone: HAProxy schreibt die Ortszeit der Maschine, und die steht
 * nirgends in der Zeile. Ein angehängtes `Z` behauptete UTC — die Kurve läge
 * dann je nach Jahreszeit ein oder zwei Stunden daneben, und niemand käme
 * darauf, dass das der Grund ist. Der Browser liest den Wert als Ortszeit, und
 * das ist bei einer Flotte in einer Zeitzone die richtige Antwort.
 */
export function toIsoHour(stamp: string): string | null {
  // Aus dem Kopf der Zeile, den HAPM schreibt: das ist UTC und sagt es auch.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(stamp)) return `${stamp}:00:00Z`;
  const match = /^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2})$/.exec(stamp);
  if (!match) return null;
  const month = MONTHS[match[2]];
  if (!month) return null;
  return `${match[3]}-${month}-${match[1]}T${match[4]}:00:00`;
}

export function parseAnalysis(stdout: string): AccessLogStats {
  const [head = '', rest = ''] = splitOnce(stdout, MARK_IPS);
  const [ipBlock = '', pathBlock = ''] = splitOnce(rest, MARK_PATHS);

  const stats: AccessLogStats = {
    ...EMPTY,
    backends: [],
    ips: [],
    paths: [],
    statusCodes: [],
    methods: [],
    hours: [],
  };
  const hours: { hour: string; count: number }[] = [];

  for (const line of head.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tag = trimmed[0];
    const body = trimmed.slice(2);

    if (tag === 'T') {
      const [lines, parsed, bytes] = body.split(' ').map(Number);
      stats.lines = safe(lines);
      stats.parsed = safe(parsed);
      stats.bytes = safe(bytes);
    } else if (tag === 'F') {
      stats.from = toIsoHour(body.trim());
    } else if (tag === 'L') {
      stats.to = toIsoHour(body.trim());
    } else if (tag === 'U') {
      stats.uniqueIps = safe(Number(body));
    } else if (tag === 'P') {
      stats.uniquePaths = safe(Number(body));
    } else if (tag === 'B') {
      // Sieben Zahlen, dann der Name — der darf Leerzeichen nicht haben, aber
      // von rechts zu lesen kostet nichts und hält auch das aus.
      const cells = body.split(' ');
      if (cells.length < 8) continue;
      const numbers = cells.slice(0, 7).map(Number);
      stats.backends.push({
        backend: cells.slice(7).join(' '),
        requests: safe(numbers[0]),
        http2xx: safe(numbers[1]),
        http3xx: safe(numbers[2]),
        http4xx: safe(numbers[3]),
        http5xx: safe(numbers[4]),
        httpOther: safe(numbers[5]),
        bytes: safe(numbers[6]),
      });
    } else if (tag === 'S' || tag === 'M') {
      const cut = body.lastIndexOf(' ');
      if (cut < 0) continue;
      const entry = { key: body.slice(0, cut), count: safe(Number(body.slice(cut + 1))) };
      (tag === 'S' ? stats.statusCodes : stats.methods).push(entry);
    } else if (tag === 'H') {
      const cut = body.lastIndexOf(' ');
      if (cut < 0) continue;
      const hour = toIsoHour(body.slice(0, cut));
      if (hour) hours.push({ hour, count: safe(Number(body.slice(cut + 1))) });
    }
  }

  stats.ips = parseCounted(ipBlock);
  stats.paths = parseCounted(pathBlock);
  stats.backends.sort((a, b) => b.requests - a.requests);
  stats.statusCodes.sort((a, b) => b.count - a.count);
  stats.methods.sort((a, b) => b.count - a.count);
  hours.sort((a, b) => a.hour.localeCompare(b.hour));
  stats.hours = hours;

  return stats;
}

/** Zeilen der Form `<Anzahl> <Schlüssel>`, schon sortiert von `sort -rn`. */
function parseCounted(block: string): Counted[] {
  const out: Counted[] = [];
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cut = trimmed.indexOf(' ');
    if (cut < 1) continue;
    const count = Number(trimmed.slice(0, cut));
    const key = trimmed.slice(cut + 1);
    if (!Number.isFinite(count) || !key) continue;
    out.push({ key, count });
  }
  return out;
}

function splitOnce(text: string, marker: string): [string, string] {
  const at = text.indexOf(marker);
  if (at < 0) return [text, ''];
  return [text.slice(0, at), text.slice(at + marker.length)];
}

function safe(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
