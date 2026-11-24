/**
 * Die Fehlerseiten des Reverse-Proxys: was ein Besucher sieht, wenn ein Ziel
 * nicht antwortet (502, 503, 504), eine Domain unbekannt ist oder eine Sperre
 * auf Admin-IPs greift (403).
 *
 * ── Was dieses Modul tut und was nicht ──
 *
 * Es bringt die Fehlerdateien, auf die `haproxy.cfg` BEREITS verweist, in das
 * Aussehen von HAPM (`ui/static/page.ts`). Es legt keine an und
 * schreibt keine `errorfile`-Zeile. Welche Fehler der Proxy mit einer
 * eigenen Seite beantwortet und wo die Dateien liegen, ist eine Einrichtung,
 * und die steht in der Datei: geraten wird nichts, dieselbe Regel wie beim
 * Marker der globalen Einstellungen.
 *
 * ── Der Code kommt aus der DATEI, nicht aus der Zeile ──
 *
 * `errorfile 503 /etc/haproxy/errors/404.http` ist kein Tippfehler, sondern ein
 * verbreiteter Griff: ein Backend ohne Server antwortet mit 503, und über die
 * Fehlerdatei wird daraus die Seite „unbekannte Domain" mit Status 404. Wer die
 * Seite nach der Zahl in der Zeile schriebe, machte aus der 404 eine 503. Was
 * eine Datei ist, sagt deshalb ihre eigene erste Zeile (`HTTP/1.0 404 Not
 * Found`), und der Status bleibt beim Neuschreiben derselbe.
 *
 * ── Eine Fehlerdatei ist eine rohe HTTP-Antwort ──
 *
 * Statuszeile, Kopfzeilen, Leerzeile, Rumpf, mit CRLF. HAProxy liest sie beim
 * Laden der Konfiguration ein und schickt sie unverändert. Fehlt eine oder ist
 * sie kaputt, lehnt es die ganze Konfiguration ab: deshalb wird nach dem
 * Schreiben geprüft und bei einem Fehlschlag zurückgestellt (`provision.ts`).
 *
 * Rein: außer dem Baustein `ui/static/page.ts` und `lib/shell.ts` kein Import.
 * `scripts/verify-proxy-pages.ts` lässt ein echtes HAProxy eine so erzeugte
 * Datei ausliefern.
 */

import { ERROR_PAGE_STATUSES, ERROR_PAGE_TEXTS, renderErrorPage } from '@/ui/static/page';
import { buildCommand, withStdin } from '../shell';
import { clean, HAPROXY_CFG } from './config';

/** Eine `errorfile`-Zeile der Konfiguration. */
export interface ErrorFileRef {
  /** Der Code in der Zeile: bei welchem Fehler HAProxy die Datei nimmt. */
  code: number;
  path: string;
}

/**
 * Alle `errorfile <code> <datei>`-Zeilen, gleich in welchem Abschnitt
 * (`defaults`, `frontend`, `backend`, `http-errors`). Die Form ist überall
 * dieselbe.
 *
 * `errorloc` und `errorfiles` fehlen mit Absicht: das eine ist eine Umleitung
 * und keine Datei, das andere ein Verweis auf einen `http-errors`-Abschnitt,
 * dessen eigene `errorfile`-Zeilen hier ohnehin gelesen werden.
 */
export function parseErrorFiles(config: string): ErrorFileRef[] {
  const refs: ErrorFileRef[] = [];
  for (const raw of config.split('\n')) {
    const match = /^errorfile\s+(\d{3})\s+(\S+)\s*$/.exec(clean(raw));
    if (match) refs.push({ code: Number(match[1]), path: match[2] });
  }
  return refs;
}

/**
 * Ob HAPM eine Datei anfasst.
 *
 * Nur unter `/etc/haproxy/`, und nur Namen aus einem engen Zeichensatz. Der
 * Pfad kommt aus `haproxy.cfg`, die jeder von Hand ändern darf, und geht in ein Kommando, das als
 * root schreibt: `errorfile 503 /etc/shadow` in einer Konfiguration darf nicht
 * dazu führen, dass diese Datei überschrieben wird. Was HAProxy unter
 * `/usr/share` oder sonst wo liest, wird angezeigt und nicht angefasst.
 */
export function isManageableErrorFile(path: string): boolean {
  return (
    /^\/etc\/haproxy\/[A-Za-z0-9._/-]+$/.test(path) &&
    !path.split('/').includes('..') &&
    !path.endsWith('/') &&
    // Die Konfiguration selbst und ihre Sicherungen liegen im selben Verzeichnis.
    !path.startsWith(HAPROXY_CFG)
  );
}

/** Der Status aus der ersten Zeile einer Fehlerdatei, oder `null`. */
export function parseStatusLine(line: string): number | null {
  const match = /^HTTP\/1\.[01]\s+(\d{3})(\s|$)/.exec(line.trim());
  return match ? Number(match[1]) : null;
}

/** Der Wortlaut hinter dem Code. Er steht in der Statuszeile, und ein Client
 *  mit HTTP/1.x zeigt ihn an, wenn er den Rumpf nicht darstellt. */
const REASONS: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  410: 'Gone',
  413: 'Payload Too Large',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

/** Die Codes, für die es eine Seite gibt. Ein anderer bleibt, wie er ist. */
export function hasErrorPage(status: number): boolean {
  return status in ERROR_PAGE_TEXTS && status in REASONS;
}

/**
 * Was auf dem Proxy anders heißt als im Baustein `ui/static/page.ts`.
 *
 * Die 403 kommt hier fast immer von der Sperre auf Admin-IPs
 * (`http-request deny deny_status 403`). „Von Ihrem Anschluss aus nicht
 * erreichbar" ist dafür die Wahrheit, und ein Knopf „Erneut versuchen" wäre
 * eine Einladung, die nichts ändert. Der Baustein sagt das schon so; hier steht
 * nur, was er NICHT wissen kann: dass eine 404 auf dem Proxy eine Domain meint
 * und keine Seite.
 */
const PROXY_TEXTS: Partial<Record<number, { title?: string; text?: string; action?: 'retry' | 'home' | 'none' }>> = {
  404: {
    title: 'Seite nicht gefunden',
    text: 'Unter dieser Adresse ist nichts eingerichtet.',
    // „Zur Startseite" führte auf dieselbe Seite: die ganze Domain ist unbekannt.
    action: 'none',
  },
};

/**
 * Die Fehlerdatei zu einem Status, als rohe HTTP-Antwort.
 *
 * `HTTP/1.1`, `Cache-Control: no-cache` und `Connection: close` wie in den
 * Dateien, die HAProxy selbst mitbringt. Ohne `Content-Length`: HAProxy rechnet
 * sie beim Laden aus, und eine hingeschriebene Zahl wäre die eine Stelle, an
 * der die Datei nach der nächsten Textänderung nicht mehr stimmt.
 */
export function renderErrorFile(status: number): string {
  if (!hasErrorPage(status)) throw new Error(`Für den Status ${status} gibt es keine Fehlerseite.`);
  return (
    `HTTP/1.1 ${status} ${REASONS[status]}\r\n` +
    'Cache-Control: no-cache\r\n' +
    'Connection: close\r\n' +
    'Content-Type: text/html; charset=utf-8\r\n' +
    '\r\n' +
    renderErrorPage(status, PROXY_TEXTS[status] ?? {})
  );
}

/** Alle Fehlerdateien, die HAPM schreiben kann. Für Tests und für
 *  die Prüfung gegen ein echtes HAProxy. */
export function errorFiles(): { status: number; content: string }[] {
  return ERROR_PAGE_STATUSES.filter(hasErrorPage).map((status) => ({
    status,
    content: renderErrorFile(status),
  }));
}

/** Was eine Fehlerdatei höchstens wiegen darf: HAProxys Puffer fasst 16384
 *  Bytes, davon gehen 1024 Reserve ab. */
export const ERROR_FILE_MAX_BYTES = 12_000;

/* ── Was auf der Maschine steht ── */

export type ErrorPageState =
  /** Die Datei trägt schon die Seite, die HAPM schriebe. */
  | 'current'
  /** Eine andere Seite: eine eigene von Hand, die von HAProxy oder eine ältere Fassung. */
  | 'other'
  /** Liegt nicht unter `/etc/haproxy/` oder heißt ungewöhnlich: wird nicht angefasst. */
  | 'foreign'
  /** Die erste Zeile ist keine Statuszeile, oder die Datei fehlt. */
  | 'unreadable'
  /** Ein Status, für den es keine Seite gibt. */
  | 'unsupported';

export interface ErrorPageEntry {
  path: string;
  /** Bei welchen Fehlern HAProxy die Datei nimmt, aus den `errorfile`-Zeilen. */
  codes: number[];
  /** Der Status, den die Datei selbst trägt. `null` heißt unbekannt. */
  status: number | null;
  state: ErrorPageState;
}

/**
 * Aus den Zeilen der Konfiguration und dem, was die Maschine über die Dateien
 * sagt, wird die Liste, die die Oberfläche zeigt und nach der geschrieben wird.
 *
 * `firstLines` und `digests` kommen aus `errorPageProbeCommands`. Fehlt ein
 * Eintrag, ist die Datei nicht lesbar: das ist eine Auskunft und wird nicht zu
 * „dann eben der Code aus der Zeile" umgedeutet.
 */
export function planErrorPages(
  refs: ErrorFileRef[],
  firstLines: Map<string, string>,
  digests: Map<string, string>,
  digestOf: (content: string) => string
): ErrorPageEntry[] {
  const byPath = new Map<string, number[]>();
  for (const ref of refs) {
    const codes = byPath.get(ref.path) ?? [];
    if (!codes.includes(ref.code)) codes.push(ref.code);
    byPath.set(ref.path, codes);
  }

  return [...byPath.entries()].map(([path, codes]) => {
    const status = parseStatusLine(firstLines.get(path) ?? '');
    const state: ErrorPageState = !isManageableErrorFile(path)
      ? 'foreign'
      : status === null
        ? 'unreadable'
        : !hasErrorPage(status)
          ? 'unsupported'
          : digests.get(path) === digestOf(renderErrorFile(status))
            ? 'current'
            : 'other';
    return { path, codes: codes.sort((a, b) => a - b), status, state };
  });
}

/** Die Einträge, die ein Schreibvorgang anfasst. */
export function writableErrorPages(entries: ErrorPageEntry[]): ErrorPageEntry[] {
  return entries.filter((entry) => entry.state === 'other');
}

/* ── Kommandos ──
 *
 * Rein und hier, damit `tests/haproxy/error-pages.test.ts` eine echte Bash sie
 * nachrechnen lassen kann. Die Dateien tragen CRLF, und ob die Wagenrückläufe
 * den Weg auf die Maschine überstehen, ist genau die Sorte Frage, die man nicht
 * aus dem Gedächtnis beantwortet: ein Heredoc verliert sie. */

/** Die erste Zeile jeder Datei, als `pfad:zeile`. Fehlende lässt `grep` aus. */
export function errorPageFirstLinesCommand(paths: string[]): string {
  // `-a`, weil eine Datei mit CRLF sonst als binär gelten kann; `-m1` nimmt die
  // erste Zeile, `-H` nennt den Pfad auch bei nur einer Datei.
  return `${buildCommand(['grep', '-a', '-m1', '-H', '', '--', ...paths])} 2>/dev/null || true`;
}

export function errorPageDigestCommand(paths: string[]): string {
  return `${buildCommand(['sha256sum', '--', ...paths])} 2>/dev/null || true`;
}

/** `pfad:zeile` je Zeile zurück in eine Zuordnung. Der Pfad enthält keinen
 *  Doppelpunkt (`isManageableErrorFile`), getrennt wird am ersten. */
export function parseFirstLines(output: string): Map<string, string> {
  const lines = new Map<string, string>();
  for (const raw of output.split('\n')) {
    const at = raw.indexOf(':');
    if (at <= 0) continue;
    lines.set(raw.slice(0, at), raw.slice(at + 1).replace(/\r$/, ''));
  }
  return lines;
}

export function parseDigests(output: string): Map<string, string> {
  const digests = new Map<string, string>();
  for (const raw of output.split('\n')) {
    const match = /^\\?([0-9a-f]{64})\s+\*?(.+)$/.exec(raw.trim());
    if (match) digests.set(match[2], match[1]);
  }
  return digests;
}

/** Wie die Sicherungen heißen: der Stand vor diesem Vorgang (für das
 *  Zurückstellen) und der allererste (die Seite von Hand, die bleiben soll). */
export function errorPageBackups(path: string): { previous: string; original: string } {
  return { previous: `${path}.hapm-previous`, original: `${path}.hapm-original` };
}

/**
 * Sichern und schreiben, in einem Kommando.
 *
 * Das Original wird genau einmal beiseitegelegt: die Seite, die jemand von
 * Hand gebaut hat, soll bei späteren Läufen nicht von einer Fassung dieses
 * Werkzeugs überschrieben werden. Mit `test -e … ||` und nicht mit `cp -n`:
 * dessen Rückgabewert beim Überspringen hat sich zwischen den Fassungen von
 * coreutils geändert, und ein Kommando, das je nach Distribution scheitert,
 * bräche die Kette vor dem Schreiben ab.
 *
 * Der vorige Stand wird jedes Mal überschrieben: er ist das, worauf dieser eine
 * Vorgang zurückstellt, wenn `haproxy -c` danach ablehnt.
 *
 * ── Warum Base64 ──
 *
 * Die Datei trägt CRLF, und ein Heredoc ist dafür kein sicherer Weg: je nach
 * Shell gehen die Wagenrückläufe verloren (unter Git Bash tun sie es), und was
 * dann dasteht, hat eine andere Prüfsumme als das, was hier entstand. Die Datei
 * gälte bei jedem Blick als „andere Seite". Base64 kennt nur Zeichen, die jede
 * Shell durchlässt; auf der Maschine entpackt `base64 -d` wieder Byte für Byte.
 *
 * `>` und nicht `mv`: der Zielinode bleibt, und mit ihm Besitzer und Rechte.
 * Der Pfad geht als Argument in das kleine Skript (`$1`) und nie in dessen Text.
 */
export function errorPageWriteCommand(path: string, content: string): string {
  const { previous, original } = errorPageBackups(path);
  const keepOriginal =
    `{ ${buildCommand(['test', '-e', original])} || ` +
    `${buildCommand(['cp', '-a', '--', path, original])}; }`;
  return [
    buildCommand(['cp', '-a', '--', path, previous]),
    keepOriginal,
    withStdin(['sh', '-c', 'base64 -d > "$1"', 'sh', path], toBase64Lines(content)),
  ].join(' && ');
}

/** Base64 in Zeilen zu 76 Zeichen, wie `base64` selbst sie schreibt. */
function toBase64Lines(content: string): string {
  const encoded = Buffer.from(content, 'utf8').toString('base64');
  return `${(encoded.match(/.{1,76}/g) ?? []).join('\n')}\n`;
}

/** Den Stand vor dem Vorgang zurückholen. */
export function errorPageRestoreCommand(path: string): string {
  return buildCommand(['cp', '-a', '--', errorPageBackups(path).previous, path]);
}
