/**
 * `/etc/haproxy/haproxy.cfg` lesen und schreiben — als reine Textfunktion.
 *
 * ── Warum das als Code hier steht und nicht als Skript neben HAProxy ──
 *
 * Ein Shell-Skript, das Einträge in die Datei schreibt, lässt sich nicht
 * testen, sondern nur ausprobieren, und seine Antwort ist Text für einen
 * Menschen, nicht Struktur für eine Oberfläche.
 *
 * Diese Datei ist der reine Teil des Verfahrens: Konfigurationstext rein,
 * Konfigurationstext raus. Kein Kommando, kein `lib/db`, keine Nebenwirkung —
 * ein Test kann jede Einfügung und jede Entfernung an echtem
 * Konfigurationstext nachrechnen, ohne dass ein HAProxy antwortet. Der Vorgang
 * darum (Zertifikat, Prüfen, Reload, Rollback) steht in
 * `lib/haproxy/provision.ts`.
 *
 * ── Warum Marker ──
 *
 * Eingefügt wird vor `# END AUTO … `, und jeder Eintrag trägt `# AUTO: <id>`.
 * Die Datei selbst ist damit die einzige Quelle: was HAPM angelegt hat, erkennt
 * es an den Markern wieder, und was jemand von Hand dazugeschrieben hat, bleibt
 * lesbar daneben stehen.
 */

import { interpolate, msg, msgid, type Message, type Params } from '../i18n/translate';

export const HAPROXY_CFG = '/etc/haproxy/haproxy.cfg';
export const HAPROXY_CERT_DIR = '/etc/haproxy/certs';

/**
 * Die Bereiche der Konfiguration.
 *
 * Ein Bereich ist ein Marker-Paar: `# BEGIN AUTO <NAME> SERVICES` …
 * `# END AUTO <NAME> SERVICES` im Frontend und dasselbe mit `BACKENDS` weiter
 * unten. Welche es gibt, steht NICHT in dieser Datei, sondern in der
 * `haproxy.cfg`.
 *
 * Eine feste Liste im Code wäre die zweite Quelle für dieselbe Sache: eine
 * weitere Gruppe bräuchte eine Änderung am Code, und die Liste wäre genau dann
 * falsch, wenn jemand in der Datei einen Block umbenennt.
 *
 * Der Name im Marker ist die Kennung. Beschriftung (`scopeLabel`) und
 * Adressteil (`scopeSlug`) werden daraus abgeleitet und nirgends gespeichert:
 * `INTERNE-TOOLS` heißt „Interne Tools" und steht unter
 * `/reverse-proxy/interne-tools`. Nur das Wort `HAPM` behält seine
 * Großbuchstaben.
 */
export type HaproxyScope = string;

export type ScopeKind = 'services' | 'backends';

const SCOPE_MARKER =
  /^#\s*(BEGIN|END)\s+AUTO\s+([A-Za-z][A-Za-z0-9_-]*)\s+(SERVICES|BACKENDS)\s*$/i;

/** Wie der Bereich in der Oberfläche heißt. */
export function scopeLabel(name: string): string {
  return name
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) =>
      // Die eine Ausnahme: HAPM ist der Name des Produkts und eine Abkürzung,
      // und die Einrichtung legt eine Gruppe dieses Namens an.
      word.toLowerCase() === 'hapm'
        ? 'HAPM'
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    )
    .join(' ');
}

/** Wie der Bereich in der Adresse heißt: /reverse-proxy/<slug>. */
export function scopeSlug(name: string): string {
  return name.toLowerCase();
}

export function scopeMarkerLine(name: string, edge: 'BEGIN' | 'END', kind: ScopeKind): string {
  return `# ${edge} AUTO ${name.toUpperCase()} ${kind === 'services' ? 'SERVICES' : 'BACKENDS'}`;
}

export interface ScopeMarker {
  index: number;
  edge: 'begin' | 'end';
  name: string;
  kind: ScopeKind;
}

/** Alle Marker-Zeilen der Datei. Gelesen wird tolerant (Groß-/Kleinschreibung,
 *  Leerzeichen nach dem `#`), geschrieben immer in derselben Form
 *  (`scopeMarkerLine`).
 *
 *  Exportiert für `streams.ts`: die TCP-Weiterleitungen liegen in denselben
 *  Marker-Blöcken. Eine zweite Erkennung daneben wäre die zweite Quelle, gegen
 *  die `parseScopes` überhaupt gebaut ist. */
export function scopeMarkers(lines: string[]): ScopeMarker[] {
  const found: ScopeMarker[] = [];
  lines.forEach((raw, index) => {
    const match = SCOPE_MARKER.exec(clean(raw));
    if (!match) return;
    found.push({
      index,
      edge: match[1].toUpperCase() === 'BEGIN' ? 'begin' : 'end',
      name: match[2],
      kind: match[3].toUpperCase() === 'SERVICES' ? 'services' : 'backends',
    });
  });
  return found;
}

export interface HaproxyScopeInfo {
  /** Der Name, wie er im Marker steht. */
  name: string;
  slug: string;
  label: string;
  /**
   * Beide END-Marker stehen genau einmal da. Ohne das lässt sich kein Dienst
   * einfügen: es gäbe keine Stelle oder zwei, und zwei hieße raten.
   */
  complete: boolean;
  /**
   * Ob sich der Bereich wieder entfernen lässt.
   *
   * Bedingung sind BEGIN **und** END in beiden Teilen und nichts als Leerzeilen
   * dazwischen. Ein vorgefundener Bereich ohne BEGIN-Marker fängt nirgends
   * sichtbar an — sein Anfang ist nur „hinter dem Marker davor", und das ist
   * beim Frontend der ganze Kopf mit `bind` und den globalen Zeilen. Was dieses
   * Werkzeug nicht angelegt hat, räumt es deshalb auch nicht weg.
   */
  removable: boolean;
}

/**
 * Die Bereiche einer Konfiguration, in der Reihenfolge ihrer SERVICES-Marker.
 */
export function parseScopes(text: string): HaproxyScopeInfo[] {
  const lines = text.split('\n');
  const markers = scopeMarkers(lines);

  const order: string[] = [];
  const byKey = new Map<string, ScopeMarker[]>();
  for (const marker of markers) {
    const key = marker.name.toUpperCase();
    if (!byKey.has(key)) {
      byKey.set(key, []);
      order.push(key);
    }
    byKey.get(key)!.push(marker);
  }

  const infos = order.map((key) => {
    const own = byKey.get(key)!;
    const name = own[0].name;
    const pick = (edge: 'begin' | 'end', kind: ScopeKind) =>
      own.filter((m) => m.edge === edge && m.kind === kind);

    const complete = pick('end', 'services').length === 1 && pick('end', 'backends').length === 1;
    const removable =
      complete &&
      (['services', 'backends'] as ScopeKind[]).every((kind) => {
        const begin = pick('begin', kind);
        const end = pick('end', kind);
        if (begin.length !== 1 || end.length !== 1) return false;
        if (begin[0].index > end[0].index) return false;
        return lines
          .slice(begin[0].index + 1, end[0].index)
          .every((line) => clean(line) === '');
      });

    return {
      name,
      slug: scopeSlug(name),
      label: scopeLabel(name),
      complete,
      removable,
      sort: pick('end', 'services')[0]?.index ?? Number.MAX_SAFE_INTEGER,
    };
  });

  infos.sort((a, b) => a.sort - b.sort);
  return infos.map(({ sort: _sort, ...info }) => info);
}

/** Der Bereich mit diesem Namen, ohne Rücksicht auf Groß-/Kleinschreibung. */
export function findScope(scopes: HaproxyScopeInfo[], name: string): HaproxyScopeInfo | undefined {
  return scopes.find((scope) => scope.name.toUpperCase() === name.trim().toUpperCase());
}

/* ── Zusätze ──
 *
 * Was sich an einem Ziel neben Domains und Adressen setzen lässt: feste Header
 * der Antwort, feste Header der Anfrage und ein langes Timeout für
 * Verbindungen, die offen bleiben. Jeder Zusatz ist EINE Zeile, einzeln
 * geschrieben und einzeln zurückgelesen, und er steht in JEDEM Backend-Block
 * des Eintrags, auch in denen der Pfad-Regeln.
 *
 * Früher waren das Presets: feste Listen, die es nur ganz oder gar nicht gab
 * („Nextcloud" = zwei Header, „Coolify" = das Timeout). Wer nur einen der
 * beiden Header wollte oder einen dritten, hatte einen Eintrag, den dieses
 * Werkzeug nicht mehr anfassen konnte. Die Zeilen der Presets sind dieselben
 * geblieben: ein Eintrag aus dieser Zeit liest sich als zwei Header bzw. als
 * der Schalter, und ein Speichern schreibt ihn Zeichen für Zeichen wieder so
 * hin.
 */

export interface HeaderRule {
  name: string;
  /** Der Wert als Text, so wie er beim Empfänger ankommt. Kein Ausdruck:
   *  siehe `headerLine`. */
  value: string;
}

/** `request`: an das Ziel. `response`: an den Besucher. */
export type HeaderDirection = 'request' | 'response';

/**
 * Das Timeout für Verbindungen, die nach dem Aufbau offen bleiben (WebSocket,
 * Terminal, Live-Ansicht).
 *
 * Ohne die Zeile fallen sie nach `timeout client`/`timeout server` aus dem
 * `defaults`-Block, üblicherweise nach einer Minute Stille. Sichtbar wird das
 * als Terminal, das mitten in der Arbeit abbricht. Ein Schalter und kein Feld
 * für die Dauer: es wäre eine Frage im Formular, auf die niemand eine andere
 * Antwort hat als „lange".
 */
export const TUNNEL_LINE = 'timeout tunnel 1h';

/* ── CrowdSec ──
 *
 * Ob CrowdSec eine Anfrage prüft, steht in der Datei wie alles andere: als
 * Block fester Zeilen, entweder im HTTPS-Frontend (für alle Ziele) oder in
 * jedem Backend eines Ziels (nur dieses). Der Bouncer läuft als eigener
 * Container und spricht SPOE; HAProxy fragt ihn je Anfrage und verweigert mit
 * 403, wenn er `ban` oder `captcha` antwortet. Warum so und nicht anders steht
 * in docs/crowdsec.md.
 */

export const CROWDSEC_SPOE_DIR = '/etc/haproxy/hapm-crowdsec';
export const CROWDSEC_SPOE_FILE = `${CROWDSEC_SPOE_DIR}/spoe.cfg`;
/**
 * Die freigegebenen Adressen, eine je Zeile, aus der Freigabeliste von
 * CrowdSec (`lib/crowdsec/allow-file.ts`). CrowdSec selbst nimmt sie nur von
 * Sperren aus, die WAF prüft ihre Anfragen trotzdem (geprüft mit CrowdSec
 * 1.8). Deshalb fragt HAProxy für sie gar nicht erst.
 */
export const CROWDSEC_ALLOW_FILE = `${CROWDSEC_SPOE_DIR}/allow.lst`;
/** Das Backend, über das HAProxy den Bouncer erreicht. Der Name steht in der
 *  SPOE-Datei (`use-backend`) und in `haproxy.cfg`. */
export const CROWDSEC_SPOA_BACKEND = 'hapm_crowdsec_spoa';
export const CROWDSEC_MARKER = '# CrowdSec';
const CROWDSEC_BACKEND_MARKER = '# CrowdSec: Verbindung zum Bouncer (HAPM)';
/** Bis zu dieser Größe geht der Rumpf einer Anfrage mit an die WAF. Größere
 *  Rümpfe passen nicht in einen SPOE-Rahmen der Vorgabegröße (16 KB samt
 *  Kopfzeilen); geprüft werden dann nur Adresse, Pfad und Kopfzeilen. */
export const CROWDSEC_BODY_MAX = 8192;

/**
 * Die Zeilen, die eine Anfrage durch CrowdSec schicken, ohne Einrückung.
 *
 * `hapm_crowdsec_done`: hat das Frontend schon gefragt (global an), fragt das
 * Backend nicht noch einmal. Ein zweiter Durchlauf durch die WAF zählte jeden
 * Treffer doppelt. Die Ablehnung gilt für `ban` und `captcha`: ein Captcha
 * kann HAPM nicht anzeigen, und durchlassen hieße, eine Sperre zu übergehen.
 * Antwortet der Bouncer nicht, setzt SPOE nur `txn.crowdsec.error`, und die
 * Anfrage geht durch.
 */
export const CROWDSEC_LINES: readonly string[] = [
  `filter spoe engine crowdsec config ${CROWDSEC_SPOE_FILE}`,
  'acl hapm_crowdsec_done var(txn.crowdsec.remediation) -m found',
  `acl hapm_crowdsec_big req.body_size -m int gt ${CROWDSEC_BODY_MAX}`,
  `acl hapm_crowdsec_allow src -f ${CROWDSEC_ALLOW_FILE}`,
  'http-request wait-for-body time 1s at-least 8k unless hapm_crowdsec_done || hapm_crowdsec_allow',
  'http-request send-spoe-group crowdsec crowdsec-http-body unless hapm_crowdsec_done || hapm_crowdsec_big || hapm_crowdsec_allow',
  'http-request send-spoe-group crowdsec crowdsec-http-no-body if hapm_crowdsec_big !hapm_crowdsec_done !hapm_crowdsec_allow',
  'http-request deny deny_status 403 if { var(txn.crowdsec.remediation) -m str ban captcha }',
];

/** Ob genau die Zeilen von `CROWDSEC_LINES` dastehen, in dieser Reihenfolge. */
function crowdsecComplete(lines: readonly string[]): boolean {
  return lines.length === CROWDSEC_LINES.length && lines.every((line, i) => line === CROWDSEC_LINES[i]);
}

/** Die SPOE-Datei, die `CROWDSEC_LINES` lädt. Die Namen der Nachrichten
 *  (`crowdsec-http-body`, `crowdsec-http-no-body`) erwartet der Bouncer genau
 *  so, andere beantwortet er nicht. */
export function crowdsecSpoeConfig(): string {
  const args =
    'remediation=var(txn.crowdsec.remediation) id=unique-id method=method path=path query=query version=req.ver headers=req.hdrs';
  const tail = 'url=url ssl=ssl_fc src-ip=src src-port=src_port';
  return [
    '# Von HAPM geschrieben. Wird beim nächsten Schreiben ersetzt.',
    '[crowdsec]',
    'spoe-agent hapm-crowdsec',
    '    groups crowdsec-http-body crowdsec-http-no-body',
    '    option var-prefix crowdsec',
    '    option set-on-error error',
    '    timeout hello 500ms',
    '    timeout idle 55s',
    '    timeout processing 500ms',
    `    use-backend ${CROWDSEC_SPOA_BACKEND}`,
    '    log global',
    '',
    'spoe-message crowdsec-http-body',
    `    args ${args} body=req.body ${tail}`,
    '',
    'spoe-message crowdsec-http-no-body',
    `    args ${args} ${tail}`,
    '',
    'spoe-group crowdsec-http-body',
    '    messages crowdsec-http-body',
    '',
    'spoe-group crowdsec-http-no-body',
    '    messages crowdsec-http-no-body',
    '',
  ].join('\n');
}

/** Ob die Konfiguration CrowdSec irgendwo benutzt (Frontend oder ein Backend). */
export function usesCrowdsec(text: string): boolean {
  return text.split('\n').some((raw) => clean(raw) === CROWDSEC_LINES[0]);
}

/**
 * Das Backend des Bouncers nachziehen: da, sobald eine Zeile CrowdSec benutzt,
 * weg, sobald keine mehr. HAProxy lehnt eine SPOE-Datei ab, deren
 * `use-backend` es nicht gibt, und ein Backend ohne Nutzer prüfte nur einen
 * Bouncer, den vielleicht niemand betreibt (Meldungen im Log).
 *
 * Ein vorhandenes Backend bleibt, wie es ist, auch mit anderem Ziel: wer den
 * Port von Hand geändert hat, meint es so. Entfernt wird nur der Block, den
 * HAPM selbst geschrieben hat (mit Marker).
 */
export function syncCrowdsecBackend(text: string, address: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((raw) => clean(raw) === `backend ${CROWDSEC_SPOA_BACKEND}`);
  const used = usesCrowdsec(text);

  if (used && start === -1) {
    const body = text.endsWith('\n') ? text : `${text}\n`;
    return `${body}\n${CROWDSEC_BACKEND_MARKER}\n${crowdsecBackendLines(address).join('\n')}\n`;
  }
  if (!used && start !== -1) {
    const markerAbove = start > 0 && clean(lines[start - 1]) === CROWDSEC_BACKEND_MARKER;
    if (!markerAbove) return text;
    let end = start + 1;
    while (end < lines.length && clean(lines[end]) !== '' && !SECTION_KEYWORDS.test(clean(lines[end]))) end++;
    let from = start - 1;
    if (from > 0 && clean(lines[from - 1]) === '') from--;
    return [...lines.slice(0, from), ...lines.slice(end)].join('\n');
  }
  return text;
}

export function crowdsecBackendLines(address: string): string[] {
  return [
    `backend ${CROWDSEC_SPOA_BACKEND}`,
    '    mode tcp',
    '    timeout connect 1s',
    '    timeout server 30s',
    `    server bouncer ${address} check inter 5s`,
  ];
}

export const HEADER_NAME_MAX = 64;
export const HEADER_VALUE_MAX = 1024;
/** Je Richtung. Eine Grenze, damit ein Backend-Block lesbar bleibt. */
export const HEADERS_MAX = 20;

const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
/** Druckbares ASCII: mehr trägt ein Header nicht verlässlich bis zum Empfänger. */
const HEADER_VALUE = /^[\x20-\x7e]+$/;

/** Header, die beschreiben, wie die Nachricht übertragen wird. Fest gesetzt
 *  zerlegen sie die Antwort oder die Anfrage, statt sie zu ergänzen. */
const TRANSPORT_HEADERS = new Set([
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
]);

/** Deutsche Schlüssel (`msgid`), der Dialog übersetzt sie beim Zeigen. */
export const HEADER_DIRECTION_LABELS: Record<HeaderDirection, string> = {
  request: msgid('Anfrage'),
  response: msgid('Antwort'),
};

export function validateHeaderRule(rule: HeaderRule): Message | null {
  const name = rule.name;
  if (!HEADER_NAME.test(name)) {
    return msg('Ungültiger Header-Name: „{name}". Erlaubt sind Buchstaben, Ziffern und der Bindestrich.', { name });
  }
  if (name.length > HEADER_NAME_MAX) {
    return msg('Der Header-Name {name} ist länger als {max} Zeichen.', { name, max: HEADER_NAME_MAX });
  }
  if (TRANSPORT_HEADERS.has(name.toLowerCase())) {
    return msg('Der Header {name} gehört zur Übertragung selbst und lässt sich nicht fest setzen.', { name });
  }
  if (rule.value === '') return msg('Der Header {name} braucht einen Wert.', { name });
  if (rule.value.length > HEADER_VALUE_MAX) {
    return msg('Der Wert von {name} ist länger als {max} Zeichen.', { name, max: HEADER_VALUE_MAX });
  }
  if (!HEADER_VALUE.test(rule.value)) {
    return msg(
      'Der Wert von {name} enthält ein Zeichen, das hier nicht geht. Erlaubt sind druckbare ASCII-Zeichen, keine Umlaute und keine Zeilenumbrüche.',
      { name }
    );
  }
  if (rule.value !== rule.value.trim()) {
    return msg('Der Wert von {name} beginnt oder endet mit einem Leerzeichen.', { name });
  }
  return null;
}

function validateHeaders(rules: readonly HeaderRule[], direction: HeaderDirection): Message | null {
  const request = direction === 'request';
  if (rules.length > HEADERS_MAX) {
    return msg(
      request
        ? 'In den Headern der Anfrage stehen mehr als {max} Einträge.'
        : 'In den Headern der Antwort stehen mehr als {max} Einträge.',
      { max: HEADERS_MAX }
    );
  }
  const seen = new Set<string>();
  for (const rule of rules) {
    const invalid = validateHeaderRule(rule);
    if (invalid) return invalid;
    // `set-header` ersetzt: der zweite Eintrag überschriebe den ersten.
    const key = rule.name.toLowerCase();
    if (seen.has(key)) {
      return msg(
        request
          ? 'Der Header {name} steht doppelt in den Headern der Anfrage.'
          : 'Der Header {name} steht doppelt in den Headern der Antwort.',
        { name: rule.name }
      );
    }
    seen.add(key);
  }
  return null;
}

/**
 * Die Zeile, die einen Header setzt.
 *
 * ── Der Wert ist Text, kein Ausdruck ──
 *
 * `set-header` nimmt in HAProxy ein Log-Format: `%[src]` würde ausgewertet,
 * `%T` durch einen Zeitstempel ersetzt. Und die Zeile selbst geht durch den
 * Parser der Konfiguration, der in Anführungszeichen `$NAME` durch eine
 * Umgebungsvariable ersetzt. Ein Wert aus einem Formular soll wörtlich
 * ankommen, deshalb wird maskiert: `%` wird `%%`, und `"`, `$` und der
 * Backslash bekommen einen Backslash davor.
 *
 * Geprüft gegen HAProxy 2.4, 3.0 und 3.4 mit Werten wie `C:\pfad`, `a\ b`,
 * `ende\`, `q\"x`, `\t`, `\$HOME`, `50%` und `%[src]`: jeder kam Zeichen für
 * Zeichen so beim Empfänger an, auch ein Backslash vor einem Leerzeichen oder
 * am Ende des Werts.
 */
export function headerLine(direction: HeaderDirection, rule: HeaderRule): string {
  const value = rule.value.replace(/%/g, '%%').replace(/[\\"$]/g, '\\$&');
  return `http-${direction} set-header ${rule.name} "${value}"`;
}

const HEADER_RULE = /^http-(request|response) set-header (\S+) "(.*)"$/;

/** Das Gegenstück zur Maskierung. `null` heißt: so hätte `headerLine` es nicht
 *  geschrieben (ein einzelnes `%`, ein `$NAME`, ein Backslash vor etwas
 *  anderem als `\`, `"` oder `$`). */
function unmaskHeaderValue(masked: string): string | null {
  let value = '';
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    const next = masked[i + 1];
    if (ch === '\\') {
      if (next !== '\\' && next !== '"' && next !== '$') return null;
      value += next;
      i++;
    } else if (ch === '%') {
      if (next !== '%') return null;
      value += '%';
      i++;
    } else if (ch === '"' || ch === '$') {
      return null;
    } else {
      value += ch;
    }
  }
  return value;
}

/**
 * Eine Zeile als Header aus dem Formular lesen.
 *
 * Sie ist nur dann einer, wenn `headerLine` aus dem Gelesenen wieder genau
 * diese Zeile macht. Alles andere (`%[src]` von Hand, eine Bedingung dahinter,
 * ein Wert ohne Anführungszeichen) bleibt eine fremde Zeile, die angezeigt und
 * nicht angefasst wird: neu geschrieben stünde dort etwas anderes.
 */
export function readHeaderLine(
  line: string
): { direction: HeaderDirection; rule: HeaderRule } | null {
  const match = HEADER_RULE.exec(line);
  if (!match) return null;
  const value = unmaskHeaderValue(match[3]);
  if (value === null) return null;
  const direction = match[1] as HeaderDirection;
  const rule = { name: match[2], value };
  if (validateHeaderRule(rule) !== null) return null;
  return headerLine(direction, rule) === line ? { direction, rule } : null;
}

/** Die Zusätze eines Eintrags, wie sie in jedem seiner Backend-Blöcke stehen. */
interface ServiceAddons {
  responseHeaders: readonly HeaderRule[];
  requestHeaders: readonly HeaderRule[];
  tunnel: boolean;
  crowdsec: boolean;
}

/** In der Reihenfolge, in der eine Anfrage sie durchläuft: erst die
 *  Verbindung, dann der Weg zum Ziel, dann der Weg zurück. */
function addonLines(addons: ServiceAddons): string[] {
  return [
    ...(addons.tunnel ? [TUNNEL_LINE] : []),
    ...(addons.crowdsec ? CROWDSEC_LINES : []),
    ...addons.requestHeaders.map((rule) => headerLine('request', rule)),
    ...addons.responseHeaders.map((rule) => headerLine('response', rule)),
  ];
}

const NEXTCLOUD_HEADERS: HeaderRule[] = [
  { name: 'X-Robots-Tag', value: 'noindex,nofollow' },
  { name: 'X-Permitted-Cross-Domain-Policies', value: 'none' },
];

/**
 * Vorschläge für Header der Antwort, im Dialog mit einem Klick einzufügen.
 *
 * Kein zweites Preset-System: ein Vorschlag fügt Zeilen ein, die danach
 * gewöhnliche Zeilen sind. Er wird nirgends gespeichert und nicht
 * zurückgelesen.
 */
export const HEADER_SUGGESTIONS: { label: string; hint: string; headers: HeaderRule[] }[] = [
  {
    label: 'Nextcloud',
    hint: msgid('Die beiden Header, die Nextcloud in seiner Sicherheitsprüfung erwartet.'),
    headers: NEXTCLOUD_HEADERS,
  },
  {
    label: 'X-Frame-Options',
    hint: msgid('Die Seite lässt sich nicht in fremde Seiten einbetten.'),
    headers: [{ name: 'X-Frame-Options', value: 'SAMEORIGIN' }],
  },
  {
    label: 'X-Robots-Tag: noindex',
    hint: msgid('Suchmaschinen nehmen die Seite nicht in ihren Index auf.'),
    headers: [{ name: 'X-Robots-Tag', value: 'noindex' }],
  },
];

/**
 * Die früheren Presets, für Aufrufer von `/api/internal`, die `preset` noch
 * schicken. `readServiceInput` übersetzt sie in die Zusätze, die sie immer
 * waren. In Antworten kommen sie nicht mehr vor.
 */
export const LEGACY_PRESETS = ['default', 'nextcloud', 'coolify'] as const;

/** Die Meldung zu einem `preset`, das es nie gab. `null`: keins geschickt oder
 *  ein bekanntes. Nicht auf „keins" gebogen: das wäre eine Entscheidung, die
 *  der Aufrufer nicht getroffen hat. */
export function legacyPresetError(body: unknown): Message | null {
  const preset = String((body as Record<string, unknown> | null)?.preset ?? '').trim();
  return preset === '' || (LEGACY_PRESETS as readonly string[]).includes(preset)
    ? null
    : msg('Unbekanntes Preset.');
}

/* ── Lastverteilung ──
 *
 * Mehrere `server`-Zeilen in einem Backend sind bereits Lastverteilung —
 * HAProxy verteilt sie nach dem `balance` aus dem `defaults`-Block,
 * üblicherweise `roundrobin`. Das Feld hier benennt das Verfahren: ohne es
 * landete eine `balance leastconn`-Zeile in `extras` und machte den Eintrag
 * unbearbeitbar.
 *
 * Deshalb ist `balance` ein eigenes Feld: es gibt genau einen Wert, und er ist
 * die Frage, um die es beim Verteilen geht.
 *
 * `null` heißt „keine Zeile" und nicht „roundrobin": was im `defaults`-Block
 * steht, gilt weiter, und eine hingeschriebene Vorgabe wäre eine Behauptung
 * über eine Datei, in die dieses Formular nicht sieht.
 */

export const HAPROXY_BALANCE = ['roundrobin', 'leastconn', 'source', 'uri', 'random'] as const;
export type HaproxyBalance = (typeof HAPROXY_BALANCE)[number];

/**
 * Die Beschriftungen sind die **etablierten Namen** und keine Übersetzungen.
 *
 * „Reihum", „Wenigste Verbindungen" oder „Nach Quell-IP" läse sich gut und
 * wäre unbrauchbar: wer wissen will, was ein Verfahren wirklich tut, sucht
 * danach — und „Reihum" findet nichts, „Round Robin" findet alles. Es ist
 * dieselbe Überlegung wie bei den Fehlermeldungen, die den HAProxy-Text
 * durchreichen statt ihn zu verdeutschen.
 *
 * Die Erklärung dazu steht in `BALANCE_HINTS`, hinter dem „i" am Feld, und
 * wird übersetzt. Der Name muss googelbar sein, der Satz daneben nicht.
 */
export const BALANCE_LABELS: Record<HaproxyBalance, string> = {
  roundrobin: 'Round Robin',
  leastconn: 'Least Connections',
  source: 'Source IP Hash',
  uri: 'URI Hash',
  random: 'Random',
};

/** Der Satz hinter dem „i". Er nennt die Zeile mit, die geschrieben wird —
 *  danach lässt sich in der HAProxy-Dokumentation suchen. */
export const BALANCE_HINTS: Record<HaproxyBalance, string> = {
  roundrobin: msgid(
    'balance roundrobin: jede Anfrage an das nächste Ziel, der Reihe nach. Der Normalfall für Webserver, die untereinander nichts teilen müssen.'
  ),
  leastconn: msgid(
    'balance leastconn: immer an das Ziel mit den wenigsten offenen Verbindungen. Passt, wenn Anfragen unterschiedlich lange dauern — etwa bei Downloads oder langen Abfragen.'
  ),
  source: msgid(
    'balance source: aus der Quell-IP wird ein Hash, und der bestimmt das Ziel. Dieselbe Adresse landet damit immer beim selben Server, ohne Cookie. Die Bindung bricht allerdings, sobald ein Ziel ausfällt oder dazukommt — dann rechnet der Hash für alle neu.'
  ),
  uri: msgid(
    'balance uri: aus dem angefragten Pfad wird ein Hash. Derselbe Pfad landet immer beim selben Ziel; gedacht für Caches vor statischen Inhalten.'
  ),
  random: msgid(
    'balance random: ein zufällig gewähltes Ziel. Verteilt auch dann gleichmäßig, wenn mehrere Proxys davorstehen und Round Robin bei jedem für sich läuft.'
  ),
};

/**
 * Der Name des Persistenz-Cookies.
 *
 * Fest und nicht einstellbar: er steht in zwei Zeilen, die zueinander passen
 * müssen (`cookie <name> insert …` im Backend und `cookie <server>` auf jeder
 * server-Zeile), und ein Feld dafür wäre eine Frage im Formular, auf die
 * niemand eine andere Antwort hat. `__Host-` scheidet aus: das Präfix verlangt
 * `Path=/` ohne `Domain`, und HAProxy setzt beides nicht.
 */
export const STICKY_COOKIE = 'HAPMSRV';

/**
 * Die Zeile, die die Sitzungsbindung anschaltet.
 *
 * `insert` — HAProxy setzt den Cookie selbst, das Ziel muss nichts können.
 * `indirect` — der Cookie wird aus der Anfrage entfernt, bevor sie hinten
 * ankommt; die Anwendung sieht ihn also nie.
 * `nocache` — sonst legt ein Proxy dazwischen die Antwort samt fremdem Cookie
 * in seinen Cache, und der nächste Besucher landet auf demselben Ziel.
 * `httponly secure` — er trägt keine Anwendungsdaten, JavaScript hat dort
 * nichts zu suchen, und alles hinter diesem Proxy läuft über HTTPS.
 */
export const STICKY_BACKEND_LINE =
  `cookie ${STICKY_COOKIE} insert indirect nocache httponly secure`;

/* ── Namensregeln ──
 *
 * ACL und Backend heißen nach der Dienst-ID. Das ist keine Konvention, sondern
 * die Bedingung dafür, dass sich ein Eintrag wiederfinden lässt: die
 * Konfiguration kennt keine Kennung, nur Namen. */

export function aclNameFor(id: string): string {
  return `host_${id}`;
}

/**
 * Eine Pfad-Regel hängt namentlich am Dienst: Backend `<id>_<name>`, ACL
 * `path_<id>_<name>`.
 *
 * Aus demselben Grund wie beim Dienst selbst — die Konfiguration kennt keine
 * Kennung, nur Namen. Nur so lässt sich beim Löschen sagen, welche der
 * dreißig ACLs im Frontend zu diesem einen Eintrag gehören, ohne zu raten.
 */
export function routeBackendFor(id: string, name: string): string {
  return `${id}_${name}`;
}

export function routeAclFor(id: string, name: string): string {
  return `path_${id}_${name}`;
}

const SERVICE_ID = /^[a-z0-9][a-z0-9_]*$/;
const DOMAIN = /^([A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/;
const BACKEND_NAME = /^[A-Za-z0-9_.-]+$/;
const BACKEND_TARGET = /^[A-Za-z0-9.-]+:[0-9]{1,5}$/;
/** Ein Pfad, wie `path_beg` ihn vergleicht: ab dem Anfang, ohne Leerzeichen. */
const ROUTE_PATH = /^\/\S*$/;

export function isValidServiceId(id: string): boolean {
  return SERVICE_ID.test(id);
}

/* ── Die Dienst-ID ergibt sich aus der Hauptdomain ──
 *
 * Sie benennt ACL und Backend, ist also die Kennung des Eintrags in der Datei.
 * Als Feld im Formular war sie eine Frage, auf die fast jeder mit einer
 * Abwandlung der Domain geantwortet hat. Vergeben wird sie beim Anlegen, und
 * zwar auf dem Server (`assignServiceId`, aufgerufen in der Vorabprüfung): nur
 * dort liegt die Datei vor, in der steht, was schon vergeben ist.
 *
 * Danach bleibt sie, wie sie ist. Wer später die Hauptdomain ändert, behält
 * die ID: sie umzuschreiben hieße, ACL, Weiche und Backend umzubenennen, und
 * mit ihnen den Cookie der Passwortsperre und jede Zeile der Historie.
 */

/** So lang wird eine abgeleitete ID höchstens. HAProxy selbst setzt keine
 *  Grenze, aber die ID steht in jedem ACL-Namen des Eintrags. Eine von Hand
 *  vergebene darf länger sein (`isValidServiceId` kennt keine Länge). */
export const SERVICE_ID_MAX = 48;

function serviceIdBase(domain: string): string {
  const name = domain.trim().toLowerCase();
  const wildcard = isWildcardDomain(name);
  const slug = (wildcard ? name.slice(2) : name)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  // `*.example.org` und `example.org` sind zwei Einträge und oft beide da. Das
  // Präfix hält sie auseinander, statt dass der zweite „example_org_2" heißt.
  const base = `${wildcard ? 'wildcard_' : ''}${slug}`.slice(0, SERVICE_ID_MAX).replace(/_+$/, '');
  return base || 'dienst';
}

/** Die erste freie Fassung: `base`, dann `base_2`, `base_3`, … Der Zähler
 *  zählt zur Länge, gekürzt wird davor. */
export function firstFreeId(base: string, taken: (id: string) => boolean): string {
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const candidate = `${base.slice(0, SERVICE_ID_MAX - suffix.length).replace(/_+$/, '')}${suffix}`;
    if (!taken(candidate)) return candidate;
  }
}

/**
 * Die Dienst-ID zu einer Hauptdomain: klein, alles außer `a-z0-9` wird `_`,
 * eine Wildcard bekommt `wildcard_` davor. Ist sie vergeben, kommt ein Zähler
 * dran.
 */
export function serviceIdFor(domain: string, taken: Iterable<string> = []): string {
  const used = new Set([...taken].map((id) => id.toLowerCase()));
  return firstFreeId(serviceIdBase(domain), (id) => used.has(id));
}

export function isValidRouteName(name: string): boolean {
  return SERVICE_ID.test(name);
}

export function isValidRoutePath(path: string): boolean {
  return ROUTE_PATH.test(path);
}

export function isValidDomain(domain: string): boolean {
  return isWildcardDomain(domain)
    ? DOMAIN.test(domain.slice(2))
    : DOMAIN.test(domain);
}

/* ── Wildcards ──
 *
 * Eine Wildcard ist eine Domain wie jede andere, nur mit `*.` davor. Kein
 * eigener Typ und kein Schalter daneben: sie steht in derselben Liste, in
 * derselben ACL und im selben Zertifikatsantrag, und jede Stelle, die heute
 * über `domains` läuft (Suche, Sperrliste, `toCreateInput`), läuft weiter.
 *
 * In der Konfiguration wird sie zu einer zweiten ACL-Zeile mit demselben Namen:
 *
 *     acl host_kunde hdr(host),lower -i kunde.example app.kunde.example
 *     acl host_kunde hdr(host),lower -m end -i .kunde.example
 *
 * Zwei Zeilen, weil `-i` je Zeile genau einen Vergleichsmodus hat; HAProxy
 * verodert gleichnamige ACLs. Der führende Punkt ist dabei der Riegel und nicht
 * Kosmetik: `-m end -i .kunde.example` trifft `a.kunde.example`, aber weder `kunde.example`
 * selbst noch `fremdekunde.example`. Ohne ihn wäre jede Domain, die zufällig auf
 * dieselben Zeichen endet, mit übernommen.
 *
 * Ein Unterschied, den man kennen muss: `-m end` trifft auch `a.b.kunde.example`,
 * ein Zertifikat `*.kunde.example` deckt diese Ebene NICHT ab. Der Verkehr landet
 * also richtig, das Zertifikat passt nicht — sichtbar als Warnung im Browser,
 * nicht als stiller Fehler. Wer die Ebene braucht, legt sie als eigenen Eintrag
 * an; die Einfügereihenfolge (siehe `serviceSortKey`) sorgt dafür, dass er die
 * Wildcard schlägt.
 */

/** Ob die Domain als Wildcard geschrieben ist. Nur `*.` am Anfang zählt: ein
 *  Stern mitten im Namen ist keine Form, die HAProxy oder acme.sh kennen. */
export function isWildcardDomain(domain: string): boolean {
  return domain.startsWith('*.');
}

/** `*.kunde.example` → `.kunde.example`, also das, was in der `-m end`-ACL steht. */
export function wildcardSuffix(domain: string): string {
  return domain.slice(1);
}

/** Das Gegenstück: `.kunde.example` → `*.kunde.example`. Für das Zurücklesen. */
export function wildcardFromSuffix(suffix: string): string {
  return `*${suffix}`;
}

/**
 * Ob `pattern` den Hostnamen `host` bedient — mit der Semantik der ACL, nicht
 * der eines Zertifikats. Ein Wildcard-Muster deckt hier also auch tiefere
 * Ebenen ab, siehe oben.
 */
export function domainCovers(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  return isWildcardDomain(p) ? h.endsWith(wildcardSuffix(p)) : p === h;
}

/**
 * Ob dieser Eintrag überhaupt einen Healthcheck haben kann.
 *
 * Er schickt `hdr Host <Hauptdomain>`, und eine Wildcard ist als Host-Header
 * kein gültiger Name: das Ziel antwortete mit 404, und HAProxy nähme ein
 * funktionierendes Backend aus dem Betrieb. Dieselbe Überlegung, aus der eine
 * Pfad-Regel gar kein `option httpchk` bekommt, nur `check`.
 *
 * Eine Bedingung und keine Fehlermeldung: „stell eine echte Domain an den
 * Anfang oder schalte den Healthcheck ab" ist eine Aufforderung, genau das zu
 * tun, was das Formular auch selbst tun kann. Der Schalter geht deshalb aus und
 * wird gesperrt, mit dem Grund daneben — sichtbar und nicht still.
 */
export function healthcheckPossible(domains: string[]): boolean {
  // Noch keine Domain getippt heißt „nichts spricht dagegen" und nicht
  // „unmöglich": sonst wäre der Schalter beim Öffnen des Dialogs gesperrt und
  // ginge erst auf, wenn das erste Feld gefüllt ist.
  return domains.length === 0 || !isWildcardDomain(domains[0]);
}

/** Ob eine Domain zu diesem Eintrag gehört: entweder steht sie in seiner Liste,
 *  oder eine Wildcard darin bedient sie. */
export function ownsDomain(domains: string[], candidate: string): boolean {
  return domains.some((d) => domainCovers(d, candidate));
}

/**
 * Ob mit dieser Sperrliste ALLE Domains des Eintrags gesperrt sind — dann tut
 * es die Host-ACL und es braucht keine zweite.
 *
 * Ein Vergleich der Mengen und nicht der Längen. Beides war dasselbe, solange
 * eine gesperrte Domain in der Liste stehen musste; mit Wildcards nicht mehr:
 * `domains: ['*.kunde.example']` und `lockedDomains: ['intern.kunde.example']` sind beide
 * einelementig und meinen das Gegenteil voneinander. Über die Länge gegangen
 * hätte das den ganzen Dienst gesperrt statt einer einzigen Adresse.
 */
export function locksEveryDomain(domains: string[], lockedDomains: string[]): boolean {
  if (lockedDomains.length === 0) return false;
  const locked = new Set(lockedDomains.map((d) => d.toLowerCase()));
  return domains.every((d) => locked.has(d.toLowerCase()));
}

export function isValidBackendName(name: string): boolean {
  return BACKEND_NAME.test(name);
}

/* ── Die Gewichtung ──
 *
 * HAProxy nimmt 0 bis 256. Die 0 ist kein Sonderfall, den man abfangen müsste,
 * sondern ein eigener Zustand: das Ziel bekommt keine neuen Verbindungen mehr,
 * behält aber seine gebundenen Sitzungen. Genau das braucht man, um einen
 * Server aus dem Betrieb zu nehmen, ohne jemanden mitten im Klicken
 * hinauszuwerfen — deshalb ist sie erlaubt und steht mit ihrem Grund in der
 * Oberfläche. */
export const WEIGHT_MIN = 0;
export const WEIGHT_MAX = 256;

export function isValidWeight(weight: number): boolean {
  return Number.isInteger(weight) && weight >= WEIGHT_MIN && weight <= WEIGHT_MAX;
}

export function isValidBackendTarget(target: string): boolean {
  if (!BACKEND_TARGET.test(target)) return false;
  const port = Number(target.slice(target.lastIndexOf(':') + 1));
  return port >= 1 && port <= 65535;
}

/**
 * Die Zieladresse einer Weiterleitung.
 *
 * Eng gefasst, und zwar aus einem Grund, der nichts mit Geschmack zu tun hat:
 * die Adresse steht unverändert in einer Zeile von `haproxy.cfg`. Ein `#` darin
 * macht den Rest der Zeile zum Kommentar — aus `code 301` würde nichts, und die
 * Weiterleitung stünde ohne Code da. Leerzeichen trennen Argumente, ein
 * Anführungszeichen bricht die Zeile auf. Deshalb: Schema, Host, optional Port,
 * optional Pfad und Query — und nichts, was HAProxy als Trenner liest.
 *
 * Kein `shellEscape`-Ersatz: die Zeile geht nicht durch eine Shell, sondern in
 * eine Datei. Der Riegel ist die Syntax der Datei, nicht die der Shell.
 */
const REDIRECT_URL = /^https?:\/\/[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*(:[0-9]{1,5})?(\/[A-Za-z0-9._~\-/%?&=+,:@!$()*[\]]*)?$/;

export function isValidRedirectUrl(url: string): boolean {
  if (!REDIRECT_URL.test(url)) return false;
  const port = /:([0-9]{1,5})(\/|$)/.exec(url.slice(url.indexOf('://') + 3));
  if (!port) return true;
  const value = Number(port[1]);
  return value >= 1 && value <= 65535;
}

/* ── Version ──
 *
 * `haproxy -v` gibt eine ganze Zeile aus:
 *
 *     HAProxy version 3.0.11-1+deb13u3 2026/05/20 - https://haproxy.org/
 *
 * Die unverändert in eine Zustandspille zu setzen war der Fehler: die Pille
 * wurde breiter als die halbe Karte, und weil sie in derselben Flexzeile sitzt
 * wie Name und Adresse, blieb für den Servernamen eine Spalte von einem Zeichen
 * Breite übrig — der Name stand senkrecht. Angezeigt wird deshalb die
 * Upstream-Version, der ganze Rest gehört in den Tooltip. */

/** Die Versionsangabe aus `haproxy -v`, samt Paketrevision der Distribution. */
export function parseHaproxyVersion(output: string): string | null {
  // `HAProxy` seit 2.4, `HA-Proxy` davor — gesucht wird deshalb das Wort
  // „version" und nicht der Produktname.
  const match = /version\s+(\S+)/i.exec(output);
  return match ? match[1] : null;
}

/** Für die Pille: ohne `-1+deb13u3`. Was die Distribution daraus gemacht hat,
 *  beantwortet keine Frage, die man auf einer Übersicht stellt. */
export function shortVersion(version: string): string {
  return version.split('-')[0];
}

/* ── Datentypen ── */

export interface HaproxyBackendServer {
  name: string;
  /** `host:port`. */
  target: string;
  /** `server … check` — HAProxy prüft dieses Ziel aktiv. */
  check: boolean;
  /**
   * Der Anteil, den dieses Ziel bekommt (`server … weight N`).
   *
   * `null` heißt **keine `weight`-Zeile** und nicht 1: HAProxys Vorgabe ist 1,
   * aber sie hinzuschreiben hieße, sie in jede bestehende Zeile einzutragen, in
   * der sie bisher nicht steht — eine Änderung an dreißig Einträgen, die
   * niemand angefordert hat. Dieselbe Regel wie bei `balance`.
   */
  weight: number | null;
  /** Wie HAProxy dieses Ziel anspricht, siehe `BackendTls`. Gelesen wird es je
   *  Zeile; das Formular kennt es je Backend (`CreateServiceInput.backendTls`). */
  tls: BackendTls;
}

/**
 * Wie HAProxy mit dem Ziel spricht: `off` ist HTTP, `insecure` HTTPS ohne
 * Prüfung des Zertifikats (`ssl verify none`, für selbst signierte wie bei
 * Proxmox oder TrueNAS), `verify` HTTPS mit Prüfung gegen die CAs des Systems
 * (`ssl verify required ca-file @system-ca`).
 *
 * EIN Feld mit drei Werten und nicht zwei Schalter: „prüfen ohne HTTPS" gibt
 * es nicht, und ein Modell, das den Zustand zulässt, braucht eine Regel mehr,
 * die ihn ablehnt. Siehe docs/reverse-proxy.md, „Ziele, die HTTPS sprechen".
 */
export const BACKEND_TLS = ['off', 'insecure', 'verify'] as const;
export type BackendTls = (typeof BACKEND_TLS)[number];

/** Die Parameter je Art, genau in dieser Reihenfolge geschrieben und gelesen. */
const BACKEND_TLS_PARAMS: Record<Exclude<BackendTls, 'off'>, readonly string[]> = {
  // Ohne `verify none` lehnt HAProxy die Zeile ab: `ssl-server-verify` steht
  // in `global` auf `required`, und ohne `ca-file` gibt es nichts zu prüfen.
  insecure: ['ssl', 'verify', 'none'],
  verify: ['ssl', 'verify', 'required', 'ca-file', '@system-ca'],
};

/** SNI aus dem Host der Anfrage: dasselbe, was der Browser bei HAProxy als SNI
 *  geschickt hat. Ein Ziel mit mehreren Zertifikaten wählt danach. */
const BACKEND_SNI = ['sni', 'req.hdr(host)'] as const;

/** Die Parameter einer HTTPS-Zeile als Text, für Doku, Hinweise und Tests. */
export function backendTlsParams(tls: BackendTls): string {
  return tls === 'off' ? '' : [...BACKEND_TLS_PARAMS[tls], ...BACKEND_SNI].join(' ');
}

/**
 * Der SNI des Healthchecks: die Hauptdomain, solange das Ziel HTTPS spricht,
 * geprüft wird und sie keine Wildcard ist. Sonst keiner.
 *
 * Der Check ist keine Anfrage, `req.hdr(host)` gibt es dort nicht, und ohne
 * `check-sni` geht er ohne SNI hinaus. Ein Ziel, das ohne SNI kein Zertifikat
 * herausgibt (Caddy, Traefik), fiele damit durch, und HAProxy nähme ein
 * funktionierendes Ziel aus dem Betrieb. Die Hauptdomain, weil der
 * HTTP-Healthcheck sie ohnehin als Host-Header schickt.
 */
export function backendCheckSni(check: boolean, tls: BackendTls, mainDomain: string): string | null {
  if (!check || tls === 'off' || !mainDomain || isWildcardDomain(mainDomain)) return null;
  return mainDomain;
}

/**
 * Ports, auf denen ein Ziel meist HTTPS spricht. Nur ein Hinweis im Formular:
 * entschieden wird nichts danach.
 */
export const HTTPS_PORT_HINTS: readonly number[] = [443, 8006, 8443, 9443];

/**
 * Was für eine Sorte Eintrag das ist.
 *
 * Abgeleitet und nirgends gespeichert: es gibt keine Zeile in `haproxy.cfg`,
 * in der es stünde. Die Auswahl beim Anlegen ist
 * eine Frage nach der Absicht und keine Eigenschaft, die mitgeschrieben würde.
 *
 * ── Warum die Ableitung vollständig sein MUSS ──
 *
 * Jede Sorte hat ein eigenes Formular, und jedes zeigt nur die Felder seiner
 * Sorte. Was ein Formular nicht zeigt, schreibt es beim Speichern auch nicht —
 * genau wie bei `extras`. Ein Eintrag mit Sitzungsbindung, den diese Funktion
 * `proxy` nennt, ginge deshalb im Reverse-Proxy-Formular auf und verlöre seine
 * Cookie-Zeilen beim ersten Speichern.
 *
 * Deshalb zählt hier ALLES, was nur die Lastverteilung kann: ein benanntes
 * Verfahren, die Bindung, eine Gewichtung, ein zweites Ziel. Jedes einzeln
 * reicht.
 */
export type ServiceKind = 'proxy' | 'balance' | 'redirect';

/* Die Felder einzeln und nicht `Pick<HaproxyService, …>`: dieselbe Frage stellt
 * sich an einem gelesenen Dienst wie an einer Eingabe aus dem Formular, und die
 * unterscheiden sich in den server-Zeilen (`check` steht nur im gelesenen). */
export function serviceKind(service: {
  redirect: RedirectTarget | null;
  servers: readonly { weight: number | null }[];
  balance: HaproxyBalance | null;
  sticky: boolean;
}): ServiceKind {
  if (service.redirect) return 'redirect';
  if (
    service.balance !== null ||
    service.sticky ||
    service.servers.length > 1 ||
    service.servers.some((s) => s.weight !== null)
  ) {
    return 'balance';
  }
  return 'proxy';
}

/**
 * Eine Pfad-Regel: dieselbe Domain, ein anderer Port.
 *
 * Der Fall, für den es sie gibt, ist Coolify: die Oberfläche läuft auf 8000,
 * das Terminal auf 6002, die Live-Ansicht auf 6001 — alles unter derselben
 * Domain, unterschieden allein am Pfad. Ohne Pfad-Regeln bräuchte jede dieser
 * Strecken eine eigene Domain samt eigenem Zertifikat, und das Terminal wäre
 * schlicht nicht erreichbar.
 *
 * In der Konfiguration ist eine Regel eine ACL plus eine Weiche plus ein
 * eigener Backend-Block. Die Weichen der Regeln stehen VOR der des Dienstes:
 * HAProxy nimmt die erste passende, und die Weiche ohne Pfadbedingung passt
 * immer.
 */
export interface HaproxyRoute {
  /** Der Namenszusatz, z. B. `terminal`. */
  name: string;
  /** `<id>_<name>` — der Backend-Name in der Konfiguration. */
  backend: string;
  /** `path_<id>_<name>`. */
  aclName: string;
  /** Die Präfixe aus `path_beg`. */
  paths: string[];
  servers: HaproxyBackendServer[];
  /** Ob die server-Zeilen ein `check` tragen. Anders als beim Dienst selbst
   *  ohne `option httpchk`: eine WebSocket-Strecke antwortet auf ein `GET /`
   *  nicht mit 200, und ein HTTP-Check nähme sie damit aus dem Betrieb. */
  check: boolean;
  /** Wie die Ziele der Regel angesprochen werden. Eigen und nicht vom Dienst
   *  geerbt: eine Regel zeigt auf einen anderen Port, oft ein anderes
   *  Programm, und ob dort HTTPS spricht, ist eine Eigenschaft dieses Ports. */
  backendTls: BackendTls;
}

/**
 * Eine Weiterleitung statt eines Backends.
 *
 * Der Fall: eine Domain, die nicht mehr selbst bedient wird, sondern woanders
 * hinzeigt — eine alte Schreibweise, ein umgezogenes Projekt, eine Domain, die
 * jemand gekauft hat und die auf die Hauptseite gehen soll. Ohne diese Sorte
 * Eintrag bräuchte das einen Server, der nichts anderes tut als 301 zu
 * antworten.
 *
 * In der Konfiguration ist es ein Backend ohne `server`-Zeile mit genau einer
 * Regel darin. Bewusst im Backend und nicht als `redirect … if host_<id>` im
 * Frontend: so bleibt alles andere gleich — Weiche, Host-ACL, Sperre auf
 * Admin-IPs, Anlegen, Löschen, Zertifikat. Eine zweite Sorte Frontend-Zeile
 * hätte jede dieser Stellen um einen Sonderfall erweitert.
 *
 * Ein Zertifikat braucht sie trotzdem: die Weiterleitung antwortet auf HTTPS,
 * und ein Browser prüft das Zertifikat, bevor er die Antwort liest.
 */
export interface RedirectTarget {
  /** Die Zieladresse, mit Schema: `https://beispiel.example`. */
  to: string;
  /**
   * Pfad und Query der Anfrage anhängen (`redirect prefix`) statt sie
   * wegzuwerfen (`redirect location`).
   *
   * Der Unterschied ist der zwischen „diese Seite ist umgezogen"
   * (`/preise` → `/preise`) und „von hier geht es dorthin" (`/preise` → `/`).
   * Beides kommt vor, und die falsche Wahl fällt erst auf, wenn jemand einen
   * alten Link öffnet.
   */
  keepPath: boolean;
  /**
   * `301` statt `302`.
   *
   * Vorgabe ist 302, und das ist die vorsichtige Richtung: ein Browser merkt
   * sich eine 301 und ruft die alte Adresse gar nicht mehr auf — eine falsch
   * gesetzte 301 lässt sich nicht zurücknehmen, ohne dass jeder Besucher seinen
   * Cache leert.
   */
  permanent: boolean;
}

export interface HaproxyService {
  /** Der Backend-Name. Er ist die Kennung des Dienstes. */
  id: string;
  aclName: string;
  /**
   * In welchem Marker-Block der Eintrag steht. `null` heißt: außerhalb beider —
   * ein von Hand gepflegter Eintrag. Der wird angezeigt und nicht angefasst.
   */
  scope: HaproxyScope | null;
  domains: string[];
  servers: HaproxyBackendServer[];
  /** Gesetzt heißt: der Eintrag leitet weiter, statt etwas zu bedienen. Dann ist
   *  `servers` leer und `routes` auch — beides zusammen kennt das Formular
   *  nicht, und ein so vorgefundener Block ist nur lesbar. */
  redirect: RedirectTarget | null;
  /** Die Pfad-Regeln, in der Reihenfolge, in der HAProxy sie prüft. */
  routes: HaproxyRoute[];
  /**
   * Das Verteilverfahren aus der `balance`-Zeile des eigenen Backends.
   *
   * `null` heißt: es steht keine da, es gilt der `defaults`-Block. Nicht
   * „roundrobin" — was dort steht, weiß dieses Modul nicht, und eine Vorgabe
   * hinzuschreiben wäre eine Behauptung darüber.
   */
  balance: HaproxyBalance | null;
  /** Sitzungsbindung über einen Cookie (`STICKY_BACKEND_LINE` plus `cookie
   *  <name>` auf jeder server-Zeile). Nur vollständig zählt sie. */
  sticky: boolean;
  /**
   * Welche Domains nur von den Admin-IPs erreichbar sind. Leer heißt: offen.
   *
   * EIN Feld statt eines Schalters plus einer Liste: „gesperrt" ist keine
   * eigene Tatsache neben „diese Domains", sondern dieselbe. Alle Domains
   * gesperrt ist der häufige Fall und schreibt sich über die Host-ACL, ein Teil
   * über eine eigene (`lock_<id>`).
   */
  lockedDomains: string[];
  /**
   * WIE die gesperrten Domains gesperrt sind: `null` heißt über die Admin-IPs,
   * gesetzt heißt mit Passwort. Ohne gesperrte Domain immer `null`.
   *
   * Gelesen steht hier, was in der Datei steht (Salz, Hash, Cookie-Wert). Auf
   * dem Weg zum Browser wird daraus `KEEP_PASSWORD`, siehe `withoutLockSecret`.
   */
  passwordLock: PasswordLockInput | null;
  healthcheck: boolean;
  /** Feste Header an den Besucher, in der Reihenfolge der Datei. Sie stehen in
   *  jedem Backend-Block des Eintrags, siehe „Zusätze". */
  responseHeaders: HeaderRule[];
  /** Feste Header an das Ziel. */
  requestHeaders: HeaderRule[];
  /** `TUNNEL_LINE` steht da: offene Verbindungen bleiben eine Stunde. */
  tunnel: boolean;
  /** `CROWDSEC_LINES` stehen im Backend: CrowdSec prüft die Anfragen dieses
   *  Ziels, auch wenn es global aus ist. */
  crowdsec: boolean;
  /** Wie die Ziele des eigenen Backends angesprochen werden. Stehen dort
   *  verschiedene Arten nebeneinander, gilt die der ersten Zeile, und der
   *  Eintrag ist nur lesbar. */
  backendTls: BackendTls;
  /** Trägt den `# AUTO: id`-Kommentar, stammt also aus einem Vorgang wie diesem. */
  auto: boolean;
  /**
   * Zeilen im Backend-Block, die dieses Modul nicht abbildet: `balance`,
   * `option forwardfor`, eigene `http-request`-Regeln, Cookie-Persistenz,
   * abweichende Timeouts.
   *
   * Sie sind der Grund, warum `editable` existiert. Bearbeiten heißt hier
   * entfernen und neu schreiben — was nicht aus der Eingabemaske stammt, wäre
   * danach weg. Ein Werkzeug, das beim Ändern einer IP still eine
   * Rate-Limit-Regel löscht, ist schlimmer als eines, das nicht ändern kann.
   */
  extras: string[];
  /**
   * Ob dieser Eintrag über die Oberfläche gelöscht werden kann.
   *
   * Bedingung ist, dass ACL und Backend so heißen, wie sie hier vergeben werden.
   * Ein Eintrag mit einer ACL, die noch für etwas anderes benutzt wird, lässt
   * sich nicht entfernen, ohne zu raten, was davon mitgehen soll — und raten ist
   * beim Reverse-Proxy die Sorte Fehler, die eine fremde Domain offline nimmt.
   */
  removable: boolean;
  /**
   * Ob er sich bearbeiten lässt: löschbar UND vollständig aus der Eingabemaske
   * reproduzierbar. Löschen ist die schwächere Bedingung — dabei geht der Block
   * ohnehin komplett weg, und das steht so im Bestätigungsdialog.
   */
  editable: boolean;
  /**
   * Die ID des Eintrags weiter oben, dessen Weiche diesem den Verkehr wegnimmt.
   * `null` ist der Normalfall.
   *
   * HAProxy nimmt die erste passende Weiche, und eine Wildcard darüber passt
   * auch für die Domains darunter. Beim Anlegen verhindert die Einfügereihenfolge
   * das; eine von Hand geschriebene oder aus der Zeit vor Wildcards stammende
   * Datei kann trotzdem so dastehen. Sie wird gelesen und nicht umsortiert —
   * aber gesagt wird es, denn sonst ist ein Eintrag, der einfach nicht antwortet,
   * die einzige Spur. `haproxy -c` findet daran nichts.
   */
  shadowedBy: string | null;
}

export interface BackendServerInput {
  /** Leer heißt: der erste freie Name `serverN`, siehe `serverNames`. */
  name: string;
  target: string;
  /** Der Anteil dieses Ziels. `null` schreibt keine `weight`-Angabe und lässt
   *  HAProxys Vorgabe gelten. Siehe `HaproxyBackendServer.weight`. */
  weight: number | null;
}

/**
 * Ein Ziel einer Pfad-Regel — ohne Gewichtung.
 *
 * Eine Pfad-Regel schickt einen Pfad auf einen anderen Port derselben Anwendung
 * (der Fall ist Coolify: Terminal, Live-Ansicht). Sie verteilt nichts, sie
 * trennt. Eine Gewichtung dort wäre ein Feld, das im Formular keine Frage
 * beantwortet — und ein Feld ohne Frage füllt irgendwann jemand aus.
 *
 * Steht auf der server-Zeile einer Regel trotzdem eine, wird sie GELESEN und der
 * Eintrag ist nur noch lesbar (`readRoute`). Sie stillschweigend wegzuschreiben
 * wäre dieselbe Sorte Verlust, gegen die `extras` überhaupt gebaut ist.
 */
export interface RouteServerInput {
  name: string;
  target: string;
}

export interface RouteInput {
  name: string;
  paths: string[];
  servers: RouteServerInput[];
  check: boolean;
  /** Eigen je Regel, siehe `HaproxyRoute.backendTls`. */
  backendTls: BackendTls;
}

export interface CreateServiceInput {
  scope: HaproxyScope;
  id: string;
  domains: string[];
  servers: BackendServerInput[];
  /** Statt `servers`: die Domains gehen woanders hin. Beides zugleich lehnt
   *  `validateCreateInput` ab — es wäre ein Backend, dessen `server`-Zeilen nie
   *  erreicht werden, und das sähe in der Datei aus wie ein Fehler. */
  redirect: RedirectTarget | null;
  /** Pfade, die woanders hin sollen als der Rest der Domain. Leer ist der
   *  Normalfall: eine Domain, ein Ziel. */
  routes: RouteInput[];
  /** Das Verteilverfahren. `null` schreibt keine `balance`-Zeile und lässt den
   *  `defaults`-Block gelten. Gilt nur für das eigene Backend, nicht für die der
   *  Pfad-Regeln: eine Regel hat ein Ziel, und wo sie mehrere hat, ist die
   *  Frage nach dem Verfahren eine andere. */
  balance: HaproxyBalance | null;
  /** Sitzungsbindung über einen Cookie. Setzt Ziele voraus und schließt eine
   *  Weiterleitung aus. */
  sticky: boolean;
  /** Die Domains, die nur für die Admin-IPs erreichbar sein sollen. Nicht leer
   *  setzt voraus, dass welche definiert sind — ohne die ACL lehnt HAProxy die
   *  Datei ab. Jede muss in `domains` stehen. */
  lockedDomains: string[];
  /**
   * Gesetzt heißt: die gesperrten Domains fragen nach einem Passwort, statt auf
   * die Admin-IPs zu prüfen. `KEEP_PASSWORD` gibt es nur beim Ändern und heißt
   * „das Passwort, das schon in der Datei steht" (`replaceService` löst es auf).
   */
  passwordLock: PasswordLockInput | null;
  /** Die Zusätze. Sie setzen ein Backend mit Zielen voraus: eine Weiterleitung
   *  beantwortet HAProxy selbst, und auf solche Antworten wirken
   *  `http-response`-Regeln nicht. */
  responseHeaders: HeaderRule[];
  requestHeaders: HeaderRule[];
  tunnel: boolean;
  /** CrowdSec prüft die Anfragen an dieses Ziel (`CROWDSEC_LINES` in jedem
   *  Backend). Setzt Ziele voraus wie die übrigen Zusätze. */
  crowdsec: boolean;
  healthcheck: boolean;
  /** Wie HAProxy die Ziele des eigenen Backends anspricht. Gilt für jede
   *  server-Zeile darin, nicht für die der Pfad-Regeln (die haben ihr eigenes).
   *  Setzt Ziele voraus und schließt eine Weiterleitung aus. */
  backendTls: BackendTls;
}

/**
 * Die Eingabe prüfen. Gibt die Meldung zurück, die der Benutzer lesen soll,
 * oder `null`.
 *
 * Eine `Message` statt eines geworfenen Fehlers, weil dieselbe Funktion im
 * Browser läuft: `ApiError` hängt über `lib/api.ts` an `next/server` und hätte
 * in einer Client-Komponente nichts zu suchen. Formular und Route prüfen damit
 * dieselbe Eingabe mit derselben Funktion — zwei Regelwerke wären ein Dialog,
 * der etwas durchlässt, was die Route danach ablehnt. Der Dialog zeigt sie mit
 * `t()`, die Route wirft sie als `ApiError`.
 */
export function validateCreateInput(input: CreateServiceInput): Message | null {
  return validateService(input, true);
}

/**
 * Dasselbe für einen Eintrag, den es noch nicht gibt: eine leere ID heißt dort
 * „wird beim Anlegen vergeben" (`assignServiceId`). Eine mitgegebene wird
 * geprüft wie immer.
 */
export function validateNewService(input: CreateServiceInput): Message | null {
  return validateService(input, input.id !== '');
}

function validateService(input: CreateServiceInput, idGiven: boolean): Message | null {
  // Nur die Form. OB es den Bereich gibt, weiß erst `addService` — dort liegt
  // die Konfiguration vor, und sie ist die einzige Wahrheit darüber.
  if (!SCOPE_NAME.test(input.scope)) return msg('Es wurde keine Gruppe ausgewählt.');
  if (idGiven && !isValidServiceId(input.id)) {
    return msg(
      'Die Dienst-ID darf nur a-z, 0-9 und _ enthalten und muss mit einem Buchstaben oder einer Ziffer beginnen.'
    );
  }
  const headersInvalid =
    validateHeaders(input.requestHeaders, 'request') ??
    validateHeaders(input.responseHeaders, 'response');
  if (headersInvalid) return headersInvalid;
  // Der Wert geht als Wort in eine Zeile der Konfiguration. Eine Allow-Liste
  // und kein Freitextfeld, aus demselben Grund wie bei den DNS-Anbietern.
  if (input.balance !== null && !HAPROXY_BALANCE.includes(input.balance)) {
    return msg('Unbekanntes Verteilverfahren.');
  }
  // Dasselbe für HTTPS zum Ziel: die Art entscheidet über Wörter auf der
  // server-Zeile, also nur, was die Liste kennt.
  if (!BACKEND_TLS.includes(input.backendTls)) {
    return msg('Unbekannte Angabe, wie das Ziel angesprochen wird. Erlaubt sind off, insecure und verify.');
  }

  if (input.domains.length === 0) return msg('Mindestens eine Domain wird benötigt.');
  for (const domain of input.domains) {
    // Ein Stern, der nicht ganz vorn und nicht vor einem Punkt steht, ist keine
    // Wildcard, sondern ein Tippfehler. Die eigene Meldung steht daneben, damit
    // sie den Grund nennt statt nur „ungültig".
    if (domain.includes('*') && !isWildcardDomain(domain)) {
      return msg('Eine Wildcard wird als *.beispiel.example geschrieben: {domain}', { domain });
    }
    if (!isValidDomain(domain)) return msg('Ungültiger Domainname: {domain}', { domain });
  }
  const seenDomains = new Set<string>();
  for (const domain of input.domains) {
    const key = domain.toLowerCase();
    if (seenDomains.has(key)) return msg('Die Domain {domain} steht doppelt in der Liste.', { domain });
    seenDomains.add(key);
  }


  /* Weiterleitung oder Backend, nie beides. Beides nebeneinander wäre ein
   * Backend, dessen `server`-Zeilen nie zum Zug kommen — die Datei sähe richtig
   * aus, und niemand fände den Grund, warum das Ziel nicht angesprochen wird. */
  if (input.redirect) {
    if (input.redirect.to === '') return msg('Die Weiterleitung braucht ein Ziel.');
    if (!isValidRedirectUrl(input.redirect.to)) {
      return msg(
        'Ungültiges Weiterleitungsziel: {target}. Erwartet wird eine vollständige Adresse wie https://beispiel.example.',
        { target: input.redirect.to }
      );
    }
    if (input.servers.length > 0) {
      return msg(
        'Eine Weiterleitung hat kein Backend-Ziel. Entweder die Domains gehen an einen Server, oder sie werden weitergeleitet.'
      );
    }
    if (input.routes.length > 0) {
      return msg(
        'Eine Weiterleitung und Pfad-Regeln schließen sich aus: es gibt kein Backend, auf das eine Regel zeigen könnte.'
      );
    }
    // Die Weiterleitung beantwortet HAProxy selbst, und auf eigene Antworten
    // wirken `http-response`-Regeln nicht (geprüft gegen 2.4 und 3.0). Die
    // Zeilen stünden wirkungslos da, also ablehnen, statt sie still wegzulassen.
    if (input.crowdsec) {
      return msg('CrowdSec prüft Anfragen an ein Backend mit Zielen. Eine Weiterleitung hat keine.');
    }
    if (addonLines(input).length > 0) {
      return msg('Header und lange Verbindungen gehören zu einem Backend mit Zielen. Eine Weiterleitung hat keine.');
    }
    // Beide beschreiben, wie Anfragen auf Ziele verteilt werden. Eine
    // Weiterleitung hat keine — die Zeilen stünden wirkungslos da und kämen
    // beim Zurücklesen als „von Hand geändert" wieder.
    if (input.balance !== null) {
      return msg('Ein Verteilverfahren gehört zu einem Backend mit Zielen. Eine Weiterleitung hat keine.');
    }
    if (input.sticky) {
      return msg('Eine Sitzungsbindung gehört zu einem Backend mit Zielen. Eine Weiterleitung hat keine.');
    }
    if (input.backendTls !== 'off') {
      return msg('HTTPS zum Ziel gehört zu einem Backend mit Zielen. Eine Weiterleitung hat keine.');
    }
  } else {
    const serversInvalid = validateServers(input.servers, null);
    if (serversInvalid) return serversInvalid;
  }

  // Eine gesperrte Domain, die dem Eintrag nicht gehört, wäre eine ACL auf eine
  // fremde Domain — der Verkehr dorthin ginge weiterhin woanders hin, und die
  // Sperre stünde wirkungslos in der Datei.
  const seenLocked = new Set<string>();
  for (const domain of input.lockedDomains) {
    // „Gehört dazu" heißt bei einer Wildcard mehr als „steht in der Liste":
    // ein Dienst auf `*.kunde.example` bedient `intern.kunde.example`, und genau die
    // einzeln zu sperren ist der Fall, für den es Wildcards gibt.
    if (!ownsDomain(input.domains, domain)) {
      return msg('Die Domain {domain} gehört nicht zu diesem Eintrag und lässt sich hier nicht sperren.', { domain });
    }
    if (seenLocked.has(domain.toLowerCase())) {
      return msg('Die Domain {domain} steht doppelt in der Sperrliste.', { domain });
    }
    seenLocked.add(domain.toLowerCase());
  }

  if (input.passwordLock !== null) {
    // Das Passwort gehört zur Sperre und nicht daneben: ohne gesperrte Domain
    // stünde ein Hash in der Datei, den keine Regel benutzt.
    if (input.lockedDomains.length === 0) {
      return msg('Eine Passwortsperre braucht mindestens eine gesperrte Domain.');
    }
    // Salz, Hash und Cookie-Wert gehen als Wörter in Zeilen der Konfiguration.
    // Geprüft wird die Form, aus demselben Grund wie bei `balance`.
    if (
      input.passwordLock !== KEEP_PASSWORD &&
      input.passwordLock !== INHERIT_LOCK &&
      !isValidPasswordLock(input.passwordLock)
    ) {
      return msg('Die Angaben der Passwortsperre haben nicht die erwartete Form.');
    }
  }

  const seenRouteNames = new Set<string>();
  const seenPaths = new Set<string>();
  for (const route of input.routes) {
    const name = route.name;
    if (!isValidRouteName(name)) {
      return msg('Ungültiger Name der Pfad-Regel: „{name}". Erlaubt sind a-z, 0-9 und _.', { name });
    }
    if (seenRouteNames.has(name)) {
      return msg('Die Pfad-Regel „{name}" steht doppelt. Aus zwei gleichen Namen würde ein Backend-Name.', { name });
    }
    seenRouteNames.add(name);

    if (route.paths.length === 0) {
      return msg('Die Pfad-Regel „{name}" hat keinen Pfad. Ohne Pfad greift sie nie.', { name });
    }
    for (const path of route.paths) {
      if (!isValidRoutePath(path)) {
        return msg(
          'Ungültiger Pfad in „{name}": {path}. Er muss mit / beginnen und darf kein Leerzeichen enthalten.',
          { name, path }
        );
      }
      // Zwei Regeln mit demselben Pfad heißen: die zweite greift nie, weil
      // HAProxy die erste passende Weiche nimmt.
      if (seenPaths.has(path)) return msg('Der Pfad {path} steht in zwei Regeln.', { path });
      seenPaths.add(path);
    }

    if (!BACKEND_TLS.includes(route.backendTls)) {
      return msg('Unbekannte Angabe, wie die Ziele der Pfad-Regel „{name}" angesprochen werden.', { name });
    }

    const routeServers = validateServers(route.servers, name);
    if (routeServers) return routeServers;
  }

  return null;
}

/** Nimmt beide Sorten Ziel: das des Backends (mit Gewichtung) und das einer
 *  Pfad-Regel (ohne). Geprüft wird sie nur, wo es sie gibt. `route` ist der
 *  Name der Pfad-Regel, `null` beim Backend. Je Sorte ein eigener Satz und
 *  keine eingesetzte Beschriftung: ein Schlüssel wird nicht zusammengesetzt. */
/**
 * Die Namen der server-Zeilen, wie sie geschrieben werden. Ein leerer Name wird
 * zum ersten freien `serverN`, gezählt ab der eigenen Position.
 *
 * Nicht stur nach Position: das Formular zeigt keinen Namen mehr, behält aber
 * die gelesenen. Aus `server1`, `server2` wird nach dem Entfernen der ersten
 * Zeile `server2` allein, und eine neu angehängte Zeile hieße nach Position
 * ebenfalls `server2`. Zwei gleich benannte Server lehnt HAProxy ab. Ohne
 * gesetzte Namen ist das Ergebnis dasselbe wie nach Position.
 */
export function serverNames(servers: readonly { name: string }[]): string[] {
  const taken = new Set(servers.map((server) => server.name).filter(Boolean));
  return servers.map((server, position) => {
    if (server.name) return server.name;
    let n = position + 1;
    while (taken.has(`server${n}`)) n++;
    const name = `server${n}`;
    taken.add(name);
    return name;
  });
}

function validateServers(
  servers: readonly { name: string; target: string; weight?: number | null }[],
  route: string | null
): Message | null {
  if (servers.length === 0) {
    return route === null
      ? msg('Mindestens ein Backend-Ziel wird benötigt.')
      : msg('Mindestens ein Ziel der Pfad-Regel „{route}" wird benötigt.', { route });
  }
  const seenNames = new Set<string>();
  for (const server of servers) {
    if (server.name) {
      if (!isValidBackendName(server.name)) return msg('Ungültiger Servername: {name}', { name: server.name });
      if (seenNames.has(server.name)) {
        return msg(
          'Der Servername {name} steht doppelt. HAProxy lehnt zwei gleich benannte Server in einem Backend ab.',
          { name: server.name }
        );
      }
      seenNames.add(server.name);
    }
    if (!isValidBackendTarget(server.target)) {
      return route === null
        ? msg('Ungültiges Backend-Ziel: {target}. Erwartet wird host:port.', { target: server.target })
        : msg('Ungültiges Ziel der Pfad-Regel „{route}": {target}. Erwartet wird host:port.', {
            route,
            target: server.target,
          });
    }
    if (server.weight !== null && server.weight !== undefined && !isValidWeight(server.weight)) {
      return msg(
        'Ungültige Gewichtung für {target}: {weight}. HAProxy nimmt eine ganze Zahl von {min} bis {max}.',
        { target: server.target, weight: server.weight, min: WEIGHT_MIN, max: WEIGHT_MAX }
      );
    }
  }
  return null;
}

/* ── Lesen ── */

export function clean(line: string): string {
  return line.replace(/\r$/, '').trim();
}

/**
 * Der Bereich einer Zeile ergibt sich aus dem NÄCHSTEN Marker darunter, nicht
 * aus einem Zustand, der beim Lesen mitgeführt wird.
 *
 * Das ist genau die Semantik des Einfügens: ein Block landet unmittelbar vor
 * seinem `# END AUTO …`. Damit stimmt die Zuordnung auch dann, wenn die
 * Konfiguration keine `# BEGIN`-Marker hat oder die beiden Blöcke in anderer
 * Reihenfolge stehen.
 */
export function scopeResolver(lines: string[], kind: ScopeKind) {
  const positions = scopeMarkers(lines)
    .filter((marker) => marker.edge === 'end' && marker.kind === kind)
    .sort((a, b) => a.index - b.index);
  return (index: number): HaproxyScope | null =>
    positions.find((p) => p.index > index)?.name ?? null;
}

/** Wo ein Konfigurationsabschnitt endet — jedes dieser Wörter beginnt einen neuen. */
export const SECTION_KEYWORDS =
  /^(global|defaults|frontend|backend|listen|resolvers|peers|userlist|mailers|cache|ring|http-errors|program)\b/;

/* ── Was sich zurücklesen lässt ──
 *
 * Diese Muster sind das Gegenstück zu `renderBackendBlock`: sie erkennen genau
 * die Zeilen, die es erzeugt. Was hier durchfällt, landet in `extras` und macht
 * den Dienst unbearbeitbar — denn Bearbeiten heißt neu schreiben, und was das
 * Formular nicht kennt, käme dabei nicht wieder mit.
 *
 * Wer `renderBackendBlock` erweitert, erweitert diese Liste mit. Der Test
 * „was gerendert wurde, ist danach bearbeitbar" hält das fest. */

/** Die drei Healthcheck-Zeilen, wie `renderBackendBlock` sie schreibt. Mit dem
 *  Host-Header, denn der hängt an der Hauptdomain. */
function healthcheckLinesFor(mainDomain: string): string[] {
  return [
    'option httpchk',
    `http-check send meth GET uri / ver HTTP/1.1 hdr Host ${mainDomain}`,
    'http-check expect status 200-399',
  ];
}

/** Ob eine Zeile zur Healthcheck-Gruppe gehört — unabhängig davon, ob die
 *  Gruppe vollständig und der Host-Header der richtige ist. */
const HEALTHCHECK_LINE = /^(option httpchk$|http-check )/;

/** Die `balance`-Zeile, so wie `renderBackendBlock` sie schreibt: ein Wort und
 *  nichts dahinter. `balance uri whole` oder `balance hdr(Host)` fällt bewusst
 *  durch — der Parameter käme beim Neuschreiben nicht wieder mit. */
const BALANCE_RULE = /^balance\s+(\S+)$/;

/** Die Weiterleitung, so wie `redirectLine` sie schreibt. Eine mit Bedingung
 *  (`… if …`) fällt bewusst durch: sie ist keine, die dieses Formular schreibt,
 *  und beim Neuschreiben verlöre sie ihre Bedingung. */
const REDIRECT_RULE = /^http-request\s+redirect\s+(location|prefix)\s+(\S+)\s+code\s+(301|302)$/;

function parseRedirectLine(line: string): RedirectTarget | null {
  const match = REDIRECT_RULE.exec(line);
  if (!match) return null;
  return { to: match[2], keepPath: match[1] === 'prefix', permanent: match[3] === '301' };
}

/** Die Host-ACL in der Form, die `hostAclLines` schreibt — einmal für die
 *  exakten Domains, einmal für die Wildcards. Eine ACL mit weiteren Bedingungen
 *  oder einem anderen Fetch wird gelesen, aber nicht neu geschrieben.
 *
 *  Die beiden schließen einander aus: hinter `,lower` steht entweder `-i` oder
 *  `-m end`, nie beides. */
const ACL_HOST_EXACT = /^hdr\(host\),lower\s+-i\s+\S/;
const ACL_HOST_SUFFIX = /^hdr\(host\),lower\s+-m\s+end\s+-i\s+\S/;

/** Welche Sorte Host-ACL eine Zeile ist. `other` heißt: gelesen, nicht
 *  reproduzierbar — und macht den Eintrag damit nur lesbar. */
type AclForm = 'exact' | 'suffix' | 'other';

/**
 * Ob die Zeilen einer ACL genau die sind, die `hostAclLines` erzeugt: höchstens
 * eine exakte und höchstens eine Suffix-Zeile, in dieser Reihenfolge.
 *
 * Auf die Reihenfolge kommt es an, obwohl HAProxy sie verodert: gelesen wird in
 * Dateireihenfolge, geschrieben wird exakt-zuerst. Eine umgekehrt vorgefundene
 * ACL käme beim Speichern also mit vertauschten Domains heraus, und die erste
 * Domain benennt die PEM-Datei — aus einer Änderung an einer Backend-IP würde
 * ein neuer Zertifikatsantrag.
 */
function aclCanonical(forms: AclForm[] | undefined): boolean {
  if (!forms || forms.length === 0 || forms.length > 2) return false;
  if (forms.includes('other')) return false;
  return forms.length === 1 || (forms[0] === 'exact' && forms[1] === 'suffix');
}

/** Eine Bedingung, die ein Name ist und keine Verknüpfung: `!acl`, `||` und
 *  `or` kommen aus einer Konfiguration von Hand und werden nicht nachgebaut. */
const PLAIN_CONDITION = /^[A-Za-z0-9_.-]+$/;

/**
 * Was hinter `server <name> <host:port>` steht, aufgeteilt.
 *
 * Exportiert, weil `streams.ts` dieselben Parameter auf denselben Zeilen liest:
 * ein `listen`-Abschnitt trägt server-Zeilen wie ein Backend. Zwei Leser für
 * eine Zeilenform wären zwei, von denen einer die Gewichtung vergisst.
 *
 * `leftover` ist alles, was danach noch dasteht. Nicht leer heißt: die Zeile
 * lässt sich nicht reproduzieren.
 */
export function readServerParams(rest: string): {
  check: boolean;
  weight: number | null;
  cookie: string | null;
  tls: BackendTls;
  checkSni: string | null;
  leftover: string[];
} {
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  let at = 0;

  const check = tokens[at] === 'check';
  if (check) at++;

  let weight: number | null = null;
  if (tokens[at] === 'weight' && tokens[at + 1] !== undefined) {
    const value = Number(tokens[at + 1]);
    // Ein unlesbarer Wert bleibt stehen und landet über `leftover` in `extras`.
    // Ihn auf eine Zahl zu biegen hieße, eine fremde Zeile umzuschreiben.
    if (isValidWeight(value)) {
      weight = value;
      at += 2;
    }
  }

  let cookie: string | null = null;
  if (tokens[at] === 'cookie' && tokens[at + 1] !== undefined) {
    cookie = tokens[at + 1];
    at += 2;
  }

  /* HTTPS zählt nur als ganze Folge, Wort für Wort so, wie `serverParams` sie
   * schreibt. `ssl verify none` ohne SNI, ein `verifyhost`, eine andere
   * `ca-file` oder ein `alpn h2` bleiben stehen und machen die Zeile nur
   * lesbar: neu geschrieben fehlte, was dort steht. */
  let tls: BackendTls = 'off';
  for (const mode of ['insecure', 'verify'] as const) {
    const expected = [...BACKEND_TLS_PARAMS[mode], ...BACKEND_SNI];
    if (expected.every((word, offset) => tokens[at + offset] === word)) {
      tls = mode;
      at += expected.length;
      break;
    }
  }

  // Nur hinter einer erkannten HTTPS-Folge. Ob der Wert der richtige ist
  // (`backendCheckSni`), weiß erst, wer die Hauptdomain kennt.
  let checkSni: string | null = null;
  if (tls !== 'off' && tokens[at] === 'check-sni' && tokens[at + 1] !== undefined) {
    checkSni = tokens[at + 1];
    at += 2;
  }

  return { check, weight, cookie, tls, checkSni, leftover: tokens.slice(at) };
}

/** Die Parameter hinter dem Ziel, in der Reihenfolge, die `readServerParams`
 *  zurückerwartet. */
export function serverParams(input: {
  check: boolean;
  weight: number | null;
  cookie: string | null;
  tls: BackendTls;
  checkSni: string | null;
}): string {
  return [
    input.check ? ' check' : '',
    input.weight === null ? '' : ` weight ${input.weight}`,
    input.cookie === null ? '' : ` cookie ${input.cookie}`,
    input.tls === 'off' ? '' : ` ${backendTlsParams(input.tls)}`,
    input.tls === 'off' || input.checkSni === null ? '' : ` check-sni ${input.checkSni}`,
  ].join('');
}

/** Ein Backend-Block beim Lesen, bevor feststeht, zu welchem Dienst er gehört. */
interface ParsedBackend {
  servers: HaproxyBackendServer[];
  /** Je server-Zeile, in derselben Reihenfolge: ihr Text und ihr `check-sni`.
   *  Erst am Ende ausgewertet, wenn die Hauptdomain feststeht. */
  serverLines: { text: string; checkSni: string | null }[];
  /** Die Zeilen der Healthcheck-Gruppe, wie sie dastehen. Erst am Ende
   *  ausgewertet: sie müssen vollständig sein UND den richtigen Host-Header
   *  tragen, sonst schriebe ein Neuschreiben etwas anderes hin. */
  checkLines: string[];
  /** Die Zusätze, jeder für sich gelesen (`readHeaderLine`, `TUNNEL_LINE`). */
  responseHeaders: HeaderRule[];
  requestHeaders: HeaderRule[];
  tunnel: boolean;
  /** Die Zeilen aus `CROWDSEC_LINES`, wie sie dastehen. Erst am Ende
   *  ausgewertet: CrowdSec zählt nur vollständig und in der Reihenfolge. */
  crowdsecLines: string[];
  crowdsec: boolean;
  /** Die Weiterleitung, wenn genau eine dasteht. Eine zweite ist ein
   *  `extras`-Eintrag: das Formular kennt eine. */
  redirect: RedirectTarget | null;
  /** Das Verteilverfahren, wenn genau eine Zeile dasteht und es zur
   *  Allow-Liste gehört. Sonst `null`, und die Zeile ist ein `extras`. */
  balance: HaproxyBalance | null;
  /** Ob die Cookie-Zeile der Sitzungsbindung dasteht. */
  stickyLine: boolean;
  /** Die server-Zeilen, die eine passende Cookie-Marke tragen. Erst am Ende
   *  ausgewertet: die Bindung zählt nur, wenn ALLE sie tragen UND die Zeile
   *  im Backend dazu dasteht — die Hälfte davon bindet nichts. */
  cookieServerLines: string[];
  /** Ob die Zählung der Passwortsperre dasteht (`LOCK_TABLE_LINE`). */
  lockTable: boolean;
  extras: string[];
  index: number;
}

/**
 * Wie die Ziele eines Backends angesprochen werden, und welche server-Zeilen
 * das nicht so tragen, wie ein Neuschreiben es täte.
 *
 * Es gilt die Art der ersten Zeile. Eine Zeile mit einer anderen ist nicht
 * reproduzierbar: das Formular kennt eine Art je Backend, und neu geschrieben
 * spräche HAProxy das Ziel danach anders an. Dasselbe gilt für einen
 * `check-sni`, der nicht der ist, den `backendCheckSni` schriebe, etwa unter
 * einer inzwischen anders heißenden Hauptdomain: die Regel des Host-Headers im
 * Healthcheck.
 */
function readBackendTls(
  backend: ParsedBackend,
  check: boolean,
  mainDomain: string
): { tls: BackendTls; extras: string[] } {
  const tls = backend.servers[0]?.tls ?? 'off';
  const expectedSni = backendCheckSni(check, tls, mainDomain);
  const extras = backend.servers.flatMap((server, position) => {
    const line = backend.serverLines[position];
    if (!line || backend.extras.includes(line.text)) return [];
    return server.tls !== tls || line.checkSni !== expectedSni ? [line.text] : [];
  });
  return { tls, extras };
}

/**
 * Die Dienste einer Konfiguration.
 *
 * Ausgegangen wird von `use_backend X if Y`: ein Dienst ist eine Weiche, die auf
 * ein Backend zeigt. Nicht von der ACL, denn eine ACL ohne `use_backend` routet
 * nichts, und nicht vom Backend, denn ein Backend ohne Weiche ist unerreichbar.
 * Beides kommt in gewachsenen Konfigurationen vor und ist kein Dienst.
 */
export function parseHaproxyConfig(text: string): HaproxyService[] {
  const lines = text.split('\n');
  const serviceScope = scopeResolver(lines, 'services');
  const backendScope = scopeResolver(lines, 'backends');

  /** ACL-Name → Domains, plus wie oft der Name überhaupt vergeben ist. */
  const acls = new Map<string, string[]>();
  /** ACL-Name → Pfade aus `path_beg`. Die zweite Sorte ACL, die dieses Modul
   *  schreibt; alle anderen werden gezählt und nicht gedeutet. */
  const pathAcls = new Map<string, string[]>();
  const aclUses = new Map<string, number>();
  /** ACL-Name → die Sorte jeder ihrer Zeilen, in Dateireihenfolge. */
  const aclForms = new Map<string, AclForm[]>();
  const autoIds = new Set<string>();
  const useBackends: { backend: string; conditions: string[]; text: string; index: number }[] = [];
  /**
   * `http-request`-Regeln im Frontend, mit ihren Bedingungen.
   *
   * Gelesen werden sie wegen der Sperre auf Admin-IPs — aber nicht nur die
   * eigene: eine fremde Regel, die auf die Host-ACL eines Dienstes zeigt, geht
   * beim Löschen mit, weil die ACL mitgeht. Sie muss also auffallen, statt
   * übersehen zu werden.
   */
  const requestRules: { text: string; conditions: string[] }[] = [];
  const backends = new Map<string, ParsedBackend>();
  /** ACL-Name → ihre Zeilen, für ACLs auf einen Cookie. Die dritte Sorte ACL,
   *  die dieses Modul schreibt: der Durchlass der Passwortsperre. */
  const cookieAcls = new Map<string, string[]>();

  let currentBackend: string | null = null;

  lines.forEach((raw, index) => {
    const line = clean(raw);

    if (currentBackend !== null && (SECTION_KEYWORDS.test(line) || /^#\s*AUTO:/.test(line))) {
      currentBackend = null;
    }

    const auto = /^#\s*AUTO:\s*(\S+)$/.exec(line);
    if (auto) {
      autoIds.add(auto[1]);
      return;
    }

    if (line.startsWith('#')) return;

    const backend = /^backend\s+(\S+)\s*$/.exec(line);
    if (backend) {
      currentBackend = backend[1];
      if (!backends.has(currentBackend)) {
        backends.set(currentBackend, {
          servers: [],
          serverLines: [],
          checkLines: [],
          responseHeaders: [],
          requestHeaders: [],
          tunnel: false,
          crowdsecLines: [],
          crowdsec: false,
          redirect: null,
          balance: null,
          stickyLine: false,
          cookieServerLines: [],
          lockTable: false,
          extras: [],
          index,
        });
      }
      return;
    }

    if (currentBackend !== null) {
      const entry = backends.get(currentBackend)!;
      if (line === '') return;

      const server = /^server\s+(\S+)\s+(\S+)(\s.*)?$/.exec(line);
      if (server) {
        const name = server[1];
        /* Was `renderBackendBlock` hinter das Ziel schreibt, in genau dieser
         * Reihenfolge: `check`, `weight N`, die Cookie-Marke. Alles andere —
         * `check inter 2s fall 3`, ein `backup`, ein `maxconn` — trägt mehr,
         * als das Formular anbietet, und macht die Zeile unreproduzierbar.
         *
         * Für HAProxy ist die Reihenfolge dieser Parameter beliebig; hier ist
         * sie es nicht. Eine anders sortierte Zeile käme beim Speichern
         * umsortiert heraus, und ein Diff, in dem sich Zeilen bewegen, ohne
         * dass sich etwas ändert, ist der, den beim Nachsehen niemand liest. */
        const { check, weight, cookie, tls, checkSni, leftover } = readServerParams(server[3] ?? '');

        entry.servers.push({ name, target: server[2], check, weight, tls });
        entry.serverLines.push({ text: line, checkSni });
        // Die Marke MUSS der eigene Servername sein: HAProxy schickt den Wert
        // aus dem Cookie an genau den Server, der so heißt. Ein abweichender
        // Wert bindet an ein anderes Ziel, und neu geschrieben stünde dort der
        // Name — eine stille Umleitung aller gebundenen Sitzungen.
        if (cookie === name) entry.cookieServerLines.push(line);
        if (leftover.length > 0 || (cookie !== null && cookie !== name)) entry.extras.push(line);
        return;
      }

      if (line === TUNNEL_LINE) {
        if (entry.tunnel) entry.extras.push(line);
        else entry.tunnel = true;
        return;
      }

      if (CROWDSEC_LINES.includes(line)) {
        entry.crowdsecLines.push(line);
        return;
      }

      const header = readHeaderLine(line);
      if (header) {
        const list = header.direction === 'response' ? entry.responseHeaders : entry.requestHeaders;
        const name = header.rule.name.toLowerCase();
        // Ein zweiter Header desselben Namens überschriebe den ersten, und das
        // Formular nimmt ihn nicht an. Gelesen wird er, neu geschrieben nicht.
        if (list.length >= HEADERS_MAX || list.some((rule) => rule.name.toLowerCase() === name)) {
          entry.extras.push(line);
        } else {
          list.push(header.rule);
        }
        return;
      }

      const balance = BALANCE_RULE.exec(line);
      if (balance) {
        // Eine zweite Zeile gewinnt bei HAProxy, aber das Formular kennt eine.
        // Ein Verfahren außerhalb der Allow-Liste wird gelesen und nicht
        // nachgebaut — es steht da, weil jemand es hingeschrieben hat.
        if (entry.balance === null && HAPROXY_BALANCE.includes(balance[1] as HaproxyBalance)) {
          entry.balance = balance[1] as HaproxyBalance;
        } else {
          entry.extras.push(line);
        }
        return;
      }

      if (line === STICKY_BACKEND_LINE) {
        if (entry.stickyLine) entry.extras.push(line);
        else entry.stickyLine = true;
        return;
      }
      if (HEALTHCHECK_LINE.test(line)) {
        entry.checkLines.push(line);
        return;
      }
      if (line === LOCK_TABLE_LINE) {
        if (entry.lockTable) entry.extras.push(line);
        else entry.lockTable = true;
        return;
      }

      const redirect = parseRedirectLine(line);
      if (redirect) {
        // Zwei Weiterleitungen in einem Backend: die zweite erreicht HAProxy
        // nie, und das Formular hat kein Feld dafür. Gelesen wird sie, neu
        // geschrieben nicht.
        if (entry.redirect) entry.extras.push(line);
        else entry.redirect = redirect;
        return;
      }

      entry.extras.push(line);
      return;
    }

    const acl = /^acl\s+(\S+)\s+(.*)$/.exec(line);
    if (acl) {
      aclUses.set(acl[1], (aclUses.get(acl[1]) ?? 0) + 1);

      const path = /^path_beg\s+(.+)$/.exec(acl[2]);
      if (path) {
        const paths = path[1].split(/\s+/).filter(Boolean);
        pathAcls.set(acl[1], [...(pathAcls.get(acl[1]) ?? []), ...paths]);
        return;
      }

      if (acl[2].startsWith('req.cook(')) {
        cookieAcls.set(acl[1], [...(cookieAcls.get(acl[1]) ?? []), line]);
        return;
      }

      if (!acl[2].includes('hdr(host)')) return;

      // Die Werte stehen hinter `-i`. Alles davor ist der Fetch samt seiner
      // Konverter (`hdr(host),lower`) und dem Vergleichsmodus und gehört nicht
      // in die Liste.
      const tokens = acl[2].split(/\s+/);
      const marker = tokens.indexOf('-i');
      if (marker === -1) {
        aclForms.set(acl[1], [...(aclForms.get(acl[1]) ?? []), 'other']);
        return;
      }
      const values = tokens.slice(marker + 1).filter(Boolean);

      let form: AclForm = ACL_HOST_SUFFIX.test(acl[2])
        ? 'suffix'
        : ACL_HOST_EXACT.test(acl[2])
          ? 'exact'
          : 'other';
      // Ein Suffix ohne führenden Punkt ist keine Wildcard, sondern ein
      // Endungsvergleich von Hand: `-m end -i kunde.example` trifft auch
      // `fremdekunde.example`. Gelesen wird er, zurückgeschrieben nicht.
      if (form === 'suffix' && !values.every((v) => v.startsWith('.'))) form = 'other';

      aclForms.set(acl[1], [...(aclForms.get(acl[1]) ?? []), form]);
      const domains = form === 'suffix' ? values.map(wildcardFromSuffix) : values;
      acls.set(acl[1], [...(acls.get(acl[1]) ?? []), ...domains]);
      return;
    }

    const rule = /^http-(?:request|response)\s+.*?\sif\s+(.+)$/.exec(line);
    if (rule) {
      requestRules.push({
        text: line,
        conditions: rule[1].trim().split(/\s+/).filter(Boolean),
      });
      return;
    }

    // Die Bedingung wird als GANZES gelesen und nicht als ein einzelner Name:
    // eine Weiche mit zwei Bedingungen ist der Normalfall, seit es Pfad-Regeln
    // gibt. Wer hier nur `if (\S+)$` erkennt, übersieht sie — und würde beim
    // Löschen des Dienstes eine Weiche stehen lassen, deren ACL mit weggeht.
    const use = /^use_backend\s+(\S+)\s+if\s+(.+)$/.exec(line);
    if (use) {
      useBackends.push({
        backend: use[1],
        conditions: use[2].trim().split(/\s+/).filter(Boolean),
        text: line,
        index,
      });
    }
  });

  // CrowdSec zählt nur, wenn der ganze Block dasteht. Eine halbe Fassung (der
  // Filter ohne Ablehnung, eine Zeile doppelt) hat jemand von Hand so gemeint:
  // gelesen wird sie, neu geschrieben nicht.
  for (const entry of backends.values()) {
    entry.crowdsec = crowdsecComplete(entry.crowdsecLines);
    if (!entry.crowdsec) entry.extras.push(...entry.crowdsecLines);
  }

  const backendUses = new Map<string, number>();
  for (const use of useBackends) {
    backendUses.set(use.backend, (backendUses.get(use.backend) ?? 0) + 1);
  }

  const services: HaproxyService[] = [];
  for (const use of useBackends) {
    // Ein Dienst ist die Weiche OHNE Pfadbedingung. Eine mit zweien ist eine
    // Pfad-Regel und gehört zu einem Dienst, statt selbst einer zu sein.
    if (use.conditions.length !== 1) continue;
    const aclName = use.conditions[0];
    const domains = acls.get(aclName);
    if (!domains) continue;

    const id = use.backend;
    const backend = backends.get(id);
    const extras: string[] = [...(backend?.extras ?? [])];

    /* ── Die Pfad-Regeln dieses Dienstes ──
     *
     * Alles, was dieselbe Host-ACL benutzt und nicht die Weiche des Dienstes
     * selbst ist. Was davon nicht dem Namensschema folgt, wird zu einem
     * `extras`-Eintrag und macht den Dienst unlöschbar: die Host-ACL wegzunehmen
     * hieße, eine fremde Weiche auf eine ACL zeigen zu lassen, die es nicht mehr
     * gibt — HAProxy startet danach nicht mehr. */
    const routes: ParsedRoute[] = [];
    let routesClean = true;

    for (const other of useBackends) {
      if (other === use || !other.conditions.includes(aclName)) continue;

      const route = readRoute(
        id,
        aclName,
        domains[0] ?? '',
        other,
        pathAcls,
        backends,
        aclUses,
        backendUses,
        backendScope
      );
      if (!route) {
        routesClean = false;
        extras.push(other.text);
        continue;
      }
      // Die Weiche des Dienstes passt IMMER; steht sie vor einer Pfad-Regel,
      // greift die Regel nie. Das ist kein Zustand, den ein Neuschreiben still
      // reparieren darf — es wäre eine Verhaltensänderung, die niemand
      // angefordert hat. Gelesen wird er, geändert nicht.
      if (other.index > use.index) routesClean = false;
      routes.push(route);
      extras.push(...route.extras);
    }
    routes.sort((a, b) => a.index - b.index);

    /* ── Die Sperre auf Admin-IPs ──
     *
     * Zwei Formen, und beide müssen Wort für Wort so dastehen, wie dieses Modul
     * sie schreibt: über die Host-ACL (alle Domains) oder über `lock_<id>`
     * (einzelne). Jede andere Regel auf einer der beiden ACLs ist ein
     * `extras`-Eintrag: sie ginge beim Speichern verloren und beim Löschen
     * ohnehin mit, weil die ACL mitgeht. */
    const lockAcl = lockAclFor(id);
    const ownRules = requestRules.filter(
      (r) => r.conditions.includes(aclName) || r.conditions.includes(lockAcl)
    );
    const fullLock = lockRuleFor(aclName);
    const partialLock = lockRuleFor(lockAcl);
    const lockedSubset = acls.get(lockAcl);

    /* ── Dasselbe mit Passwort ──
     *
     * Dieselben zwei Formen (alle Domains über die Host-ACL, einzelne über
     * `lock_<id>`), nur mit den sechs Regeln der Abfrage statt der einen
     * Deny-Regel. Gelesen wird sie nur vollständig, siehe `readPasswordLock`. */
    const ruleTexts = ownRules.map((r) => r.text);
    const passAclTexts = cookieAcls.get(passAclFor(id)) ?? [];
    const ipFull = ruleTexts.includes(fullLock);
    const ipPartial = !ipFull && ruleTexts.includes(partialLock) && lockedSubset !== undefined;
    const fullPass =
      ipFull || ipPartial ? null : readPasswordLock(id, aclName, ruleTexts, passAclTexts);
    const partialPass =
      ipFull || ipPartial || fullPass || !lockedSubset
        ? null
        : readPasswordLock(id, lockAcl, ruleTexts, passAclTexts);
    const passwordLock = fullPass ?? partialPass;
    const passRules = passwordLock
      ? passwordLockRules(id, fullPass ? aclName : lockAcl, passwordLock)
      : [];

    let lockedDomains: string[] = [];
    if (ipFull || fullPass) {
      lockedDomains = [...domains];
    } else if ((ipPartial || partialPass) && lockedSubset) {
      // Eine Teil-Sperre auf Domains, die dem Dienst gar nicht gehören, ist
      // nicht das, was dieses Formular schreibt — dann lieber nur lesen.
      // „Gehört dazu" schließt die Adressen unter einer Wildcard des Dienstes
      // mit ein, siehe `ownsDomain`.
      lockedDomains = lockedSubset.filter((d) => ownsDomain(domains, d));
      if (lockedDomains.length !== lockedSubset.length || !aclCanonical(aclForms.get(lockAcl))) {
        extras.push(`acl ${lockAcl} … ${lockedSubset.join(' ')}`);
      }
    }
    extras.push(
      ...ruleTexts.filter(
        (text) => text !== fullLock && text !== partialLock && !passRules.includes(text)
      )
    );
    // Eine Cookie-ACL ohne die Regeln dazu ginge beim Speichern verloren, und
    // die Zählung im Backend gehört zur Sperre: ohne sie gäbe es beliebig viele
    // Versuche, und neu geschrieben stünde sie da.
    if (!passwordLock) extras.push(...passAclTexts);
    const lockTable = backend?.lockTable ?? false;
    if (passwordLock && !lockTable) {
      extras.push(`Passwortsperre ohne "${LOCK_TABLE_LINE}" im Backend`);
    }
    if (!passwordLock && lockTable) extras.push(LOCK_TABLE_LINE);
    // Beides gleichzeitig ergäbe zwei Deny-Regeln, von denen das Formular nur
    // eine kennt.
    if (ownRules.some((r) => r.text === fullLock) && ownRules.some((r) => r.text === partialLock)) {
      extras.push(partialLock);
    }

    // Jedes Backend des Dienstes trägt dieselben Zusätze. Eine Pfad-Regel mit
    // anderen ist nicht reproduzierbar: beim Speichern stünde dort, was im
    // Backend des Dienstes steht.
    const ownAddons = backend ? addonLines(backend) : [];
    const routeAddonsMatch = routes.every(
      (route) => route.addonLines.join('\n') === ownAddons.join('\n')
    );

    // Die Healthcheck-Gruppe muss vollständig sein UND den Host-Header der
    // Hauptdomain tragen: `hdr Host alt.example` unter einer Domain, die inzwischen
    // anders heißt, würde beim Speichern still umgeschrieben.
    const checkLines = backend?.checkLines ?? [];
    const expectedCheck = healthcheckLinesFor(domains[0] ?? '');
    const healthcheck =
      checkLines.length === expectedCheck.length &&
      expectedCheck.every((l) => checkLines.includes(l));
    if (checkLines.length > 0 && !healthcheck) extras.push(...checkLines);

    // HTTPS zum Ziel: eine Art für alle Zeilen, und der SNI des Healthchecks
    // ist der, den ein Neuschreiben setzen würde.
    const backendTls = backend
      ? readBackendTls(backend, healthcheck, domains[0] ?? '')
      : { tls: 'off' as const, extras: [] };
    extras.push(...backendTls.extras);

    // `option httpchk` ohne `check` auf der server-Zeile prüft nichts; unsere
    // Ausgabe setzt immer beides. Ein Neuschreiben würde also etwas ändern.
    const serversMatchCheck = (backend?.servers ?? []).every((s) => s.check === healthcheck);

    /* ── Die Sitzungsbindung zählt nur vollständig ──
     *
     * Sie besteht aus zwei Hälften, die zueinander gehören: der `cookie`-Zeile
     * im Backend und der Marke auf jeder server-Zeile. Die Zeile allein setzt
     * einen Cookie, den niemand einlöst; die Marken allein werden nie gesetzt.
     * Was halb dasteht, hat jemand von Hand so gemeint — gelesen wird es, neu
     * geschrieben nicht. */
    const ownServers = backend?.servers ?? [];
    const cookieLines = backend?.cookieServerLines ?? [];
    const stickyLine = backend?.stickyLine ?? false;
    const sticky = stickyLine && ownServers.length > 0 && cookieLines.length === ownServers.length;
    if (!sticky) {
      if (stickyLine) extras.push(STICKY_BACKEND_LINE);
      extras.push(...cookieLines);
    }

    /* Eine Weiterleitung schließt Ziele, Pfad-Regeln, Zusätze, Healthcheck,
     * Verteilverfahren und Sitzungsbindung aus — `renderBackendBlock` schreibt
     * bei einer Weiterleitung nichts davon. Steht beides da, ist der Block
     * gelesen, aber nicht reproduzierbar: ein Speichern ließe die Hälfte weg. */
    const redirect = backend?.redirect ?? null;
    const redirectStandsAlone =
      redirect === null ||
      (ownServers.length === 0 &&
        routes.length === 0 &&
        ownAddons.length === 0 &&
        checkLines.length === 0 &&
        (backend?.balance ?? null) === null &&
        !stickyLine);
    if (redirect && !redirectStandsAlone) extras.push(redirectLine(redirect));

    // Löschbar nur, wenn die Namen unserem Schema folgen UND weder ACL noch
    // Weiche noch Backend anderswo ein zweites Mal vorkommen. Sonst nähme das
    // Entfernen etwas mit, wovon der Eintrag nichts weiß.
    // Wie viele ACL-Zeilen dieser Eintrag SELBST hätte: eine, und mit Wildcards
    // zwei. Verglichen wird gegen diese Zahl und nicht gegen 1 — sonst wäre ein
    // Eintrag mit Wildcard nie löschbar, weil seine zweite eigene Zeile wie eine
    // fremde aussähe.
    const ownAclLines = hostAclLines(aclName, domains).length;
    const removable =
      aclName === aclNameFor(id) &&
      (aclUses.get(aclName) ?? 0) === ownAclLines &&
      (backendUses.get(id) ?? 0) === 1 &&
      backend !== undefined &&
      backendScope(backend.index) !== null &&
      // Eine fremde Weiche auf dieser ACL: siehe oben, das Löschen risse sie mit.
      routes.length === useBackends.filter((u) => u !== use && u.conditions.includes(aclName)).length;

    services.push({
      id,
      aclName,
      scope: serviceScope(use.index),
      domains,
      servers: backend?.servers ?? [],
      redirect,
      routes: routes.map(({ extras: _extras, index: _index, addonLines: _addons, ...route }) => route),
      balance: backend?.balance ?? null,
      sticky,
      lockedDomains,
      passwordLock: lockedDomains.length > 0 ? passwordLock : null,
      healthcheck,
      responseHeaders: backend?.responseHeaders ?? [],
      requestHeaders: backend?.requestHeaders ?? [],
      tunnel: backend?.tunnel ?? false,
      crowdsec: backend?.crowdsec ?? false,
      backendTls: backendTls.tls,
      auto: autoIds.has(id),
      extras,
      removable,
      // Bearbeiten heißt entfernen und neu schreiben. Es setzt deshalb voraus,
      // dass sich der ganze Eintrag aus der Eingabemaske reproduzieren lässt —
      // sonst verschwände beim Ändern einer IP eine Regel, nach der niemand
      // gefragt hat.
      editable:
        removable &&
        extras.length === 0 &&
        routesClean &&
        routeAddonsMatch &&
        serversMatchCheck &&
        aclCanonical(aclForms.get(aclName)),
      shadowedBy: null,
    });
  }

  // `services` steht in der Reihenfolge der Weichen in der Datei, also in der
  // Reihenfolge, in der HAProxy sie prüft. Verdeckt wird ein Eintrag deshalb
  // immer von einem WEITER OBEN.
  for (let i = 1; i < services.length; i++) {
    const shadow = services
      .slice(0, i)
      .find((above) =>
        services[i].domains.some((domain) => above.domains.some((p) => domainCovers(p, domain)))
      );
    if (shadow) services[i].shadowedBy = shadow.id;
  }

  return services;
}

/** Eine Pfad-Regel beim Lesen: alles, was sie nicht reproduzierbar macht,
 *  kommt als `extras` zurück; passt schon der Name nicht, gibt es sie nicht. */
type ParsedRoute = HaproxyRoute & { extras: string[]; addonLines: string[]; index: number };

function readRoute(
  id: string,
  hostAcl: string,
  mainDomain: string,
  use: { backend: string; conditions: string[]; index: number },
  pathAcls: Map<string, string[]>,
  backends: Map<string, ParsedBackend>,
  aclUses: Map<string, number>,
  backendUses: Map<string, number>,
  backendScope: (index: number) => HaproxyScope | null
): ParsedRoute | null {
  // Genau zwei Bedingungen: die Host-ACL und der Pfad. Die Reihenfolge ist egal
  // — HAProxy verknüpft mit UND —, alles Weitere nicht: `!acl` oder `||` bauen
  // wir nicht nach.
  if (use.conditions.length !== 2) return null;
  if (!use.conditions.every((c) => PLAIN_CONDITION.test(c))) return null;

  const aclName = use.conditions.find((c) => c !== hostAcl);
  if (!aclName) return null;

  // Der Name der Regel steht an zwei Stellen und muss an beiden derselbe sein.
  // Sonst ließe sich beim Löschen nicht sagen, welche ACL zu welchem Backend
  // gehört — und geraten wird hier nicht.
  if (!use.backend.startsWith(`${id}_`)) return null;
  const name = use.backend.slice(id.length + 1);
  if (!isValidRouteName(name) || aclName !== routeAclFor(id, name)) return null;

  const paths = pathAcls.get(aclName);
  if (!paths || paths.length === 0) return null;
  if ((aclUses.get(aclName) ?? 0) !== 1) return null;
  if ((backendUses.get(use.backend) ?? 0) !== 1) return null;

  const backend = backends.get(use.backend);
  if (!backend || backendScope(backend.index) === null) return null;

  const servers = backend.servers;
  const check = servers.length > 0 && servers.every((s) => s.check);
  const mixed = servers.some((s) => s.check !== check);
  const tls = readBackendTls(backend, check, mainDomain);

  return {
    name,
    backend: use.backend,
    aclName,
    paths,
    servers,
    check,
    backendTls: tls.tls,
    // Eine Pfad-Regel schreibt keine httpchk-Zeilen: eine WebSocket-Strecke
    // antwortet auf ein `GET /` nicht mit 200. Stehen dort welche, hat sie
    // jemand von Hand gesetzt, und ein Neuschreiben nähme sie weg.
    //
    // Dasselbe gilt für eine Gewichtung: `RouteServerInput` kennt keine, das
    // Formular zeigt keine, und `renderRouteBackend` schriebe sie nicht wieder
    // hin. Gelesen wird sie trotzdem — die Karte soll das Ziel zeigen.
    extras: [
      ...backend.extras,
      ...backend.checkLines,
      ...(mixed ? servers.map((s) => `server ${s.name} ${s.target}`) : []),
      ...servers
        .filter((s) => s.weight !== null)
        .map((s) => `server ${s.name} ${s.target} weight ${s.weight}`),
      ...tls.extras,
    ],
    addonLines: addonLines(backend),
    index: use.index,
  };
}

/** Ob eine Domain schon in irgendeiner Host-ACL steht. Vergleich ohne Groß-/Kleinschreibung. */
export function findDomainConflict(
  services: HaproxyService[],
  domains: string[]
): { domain: string; service: HaproxyService } | null {
  for (const domain of domains) {
    const needle = domain.toLowerCase();
    const hit = services.find((s) => s.domains.some((d) => d.toLowerCase() === needle));
    if (hit) return { domain, service: hit };
  }
  return null;
}

/* ── Schreiben ── */

/**
 * Die Host-ACL, ohne Einrückung: eine Zeile für die exakten Domains, eine für
 * die Wildcards.
 *
 * Die exakte Zeile steht zuerst, und das ist die Form, die `parseHaproxyConfig`
 * zurückerwartet — eine andere Reihenfolge liest sich zwar genauso, käme beim
 * Neuschreiben aber umsortiert wieder heraus, und `certificateChanged` hielte
 * das für geänderte Domains. Für HAProxy ist die Reihenfolge zweier
 * gleichnamiger ACL-Zeilen egal, sie werden verodert.
 */
export function hostAclLines(aclName: string, domains: string[]): string[] {
  const exact = domains.filter((d) => !isWildcardDomain(d));
  const wildcards = domains.filter(isWildcardDomain);
  const lines: string[] = [];
  if (exact.length > 0) {
    lines.push(`acl ${aclName} hdr(host),lower -i ${exact.join(' ')}`);
  }
  if (wildcards.length > 0) {
    lines.push(
      `acl ${aclName} hdr(host),lower -m end -i ${wildcards.map(wildcardSuffix).join(' ')}`
    );
  }
  return lines;
}

/**
 * ACL und Weiche, so wie sie im Frontend stehen.
 *
 * Vier Leerzeichen Einrückung, weil der Rest der Datei das auch hat — eine
 * Konfiguration, die je nach Werkzeug anders eingerückt ist, liest sich beim
 * Nachsehen von Hand wie zwei verschiedene Dateien.
 */
export function renderServiceBlock(input: CreateServiceInput): string[] {
  const acl = aclNameFor(input.id);
  const lines = [
    '',
    `    # AUTO: ${input.id}`,
    ...hostAclLines(acl, input.domains).map((line) => `    ${line}`),
  ];

  for (const route of input.routes) {
    lines.push(`    acl ${routeAclFor(input.id, route.name)} path_beg ${route.paths.join(' ')}`);
  }

  /* Die Sperre steht vor den Weichen, obwohl HAProxy sie ohnehin zuerst
   * auswertet: wer die Datei liest, soll sie vor dem Ziel sehen und nicht
   * darunter. Die ACL `admin_ips` selbst steht am Kopf des Frontends — hier
   * wird sie nur benutzt.
   *
   * Alle Domains gesperrt heißt: die Host-ACL tut es. Sonst braucht es eine
   * zweite ACL mit genau den gesperrten Domains. */
  if (input.lockedDomains.length > 0) {
    const every = locksEveryDomain(input.domains, input.lockedDomains);
    const target = every ? acl : lockAclFor(input.id);
    if (!every) {
      lines.push(...hostAclLines(target, input.lockedDomains).map((line) => `    ${line}`));
    }
    // Mit Passwort stehen an der Stelle der einen Deny-Regel die Cookie-ACL
    // und die sechs Regeln der Abfrage. Welche Domains gemeint sind, sagt in
    // beiden Fällen dieselbe ACL.
    const password = passwordLockOf(input);
    if (password) {
      lines.push(`    ${passAclLine(input.id, password)}`);
      lines.push(...passwordLockRules(input.id, target, password).map((line) => `    ${line}`));
    } else {
      lines.push(`    ${lockRuleFor(target)}`);
    }
  }

  /* Die Weichen der Pfad-Regeln stehen VOR der des Dienstes, und das ist keine
   * Kosmetik: HAProxy nimmt die erste passende, und die Weiche ohne
   * Pfadbedingung passt für jede Anfrage an diese Domain. Stünde sie oben,
   * liefen die Regeln darunter nie — und zwar ohne Fehlermeldung, `haproxy -c`
   * sieht daran nichts Falsches. */
  for (const route of input.routes) {
    lines.push(
      `    use_backend ${routeBackendFor(input.id, route.name)} if ${acl} ${routeAclFor(input.id, route.name)}`
    );
  }
  lines.push(`    use_backend ${input.id} if ${acl}`);

  return lines;
}

/** Die Zusätze, eingerückt und mit einer Leerzeile dahinter. Sie stehen in
 *  JEDEM Backend des Dienstes. */
function addonBlock(addons: ServiceAddons): string[] {
  const lines = addonLines(addons);
  return lines.length === 0 ? [] : [...lines.map((line) => `    ${line}`), ''];
}

/**
 * Die eine Zeile, die eine Weiterleitung ausmacht.
 *
 * `location` ersetzt die ganze Adresse, `prefix` hängt Pfad und Query an. Der
 * Code steht am Ende und nicht als Vorgabe des Schlüsselworts: HAProxys eigene
 * Vorgabe ist 302, aber sie hinzuschreiben kostet nichts und macht die Datei
 * beim Nachsehen von Hand eindeutig.
 */
export function redirectLine(redirect: RedirectTarget): string {
  const kind = redirect.keepPath ? 'prefix' : 'location';
  return `http-request redirect ${kind} ${redirect.to} code ${redirect.permanent ? '301' : '302'}`;
}

export function renderBackendBlock(input: CreateServiceInput): string[] {
  const lines = ['', `# AUTO: ${input.id}`, `backend ${input.id}`];
  // Die Zählung der Passwortsperre. Sie steht auch im Backend einer
  // Weiterleitung: gezählt wird im Frontend, hier liegt nur die Tabelle.
  const lockTable = passwordLockOf(input) !== null;

  // Eine Weiterleitung ist ein Backend aus einer Zeile: keine Zusätze, kein
  // Healthcheck, keine Ziele, keine Pfad-Regeln. Alles davon setzt einen Server
  // voraus, den es hier nicht gibt — `validateCreateInput` lehnt es vorher ab.
  if (input.redirect) {
    if (lockTable) lines.push(`    ${LOCK_TABLE_LINE}`);
    lines.push(`    ${redirectLine(input.redirect)}`);
    return lines;
  }

  /* Verfahren und Bindung stehen ganz oben, vor Zusätzen und Healthcheck: sie
   * sagen, was dieses Backend mit seinen Zielen macht, und wer die Datei von
   * Hand liest, sucht das über den server-Zeilen und nicht darunter. Für
   * HAProxy ist die Reihenfolge innerhalb eines Abschnitts ohne Bedeutung. */
  const head: string[] = [];
  if (lockTable) head.push(`    ${LOCK_TABLE_LINE}`);
  if (input.balance) head.push(`    balance ${input.balance}`);
  if (input.sticky) head.push(`    ${STICKY_BACKEND_LINE}`);
  if (head.length > 0) lines.push(...head, '');

  lines.push(...addonBlock(input));

  if (input.healthcheck) {
    // Der Host-Header trägt die Hauptdomain: ein virtueller Host antwortet auf
    // eine Anfrage ohne passenden Host sonst mit 404, und der Healthcheck
    // nähme ein funktionierendes Ziel aus dem Betrieb.
    lines.push(...healthcheckLinesFor(input.domains[0]).map((line) => `    ${line}`));
    lines.push('');
  }

  const names = serverNames(input.servers);
  input.servers.forEach((server, position) => {
    const name = names[position];
    lines.push(
      `    server ${name} ${server.target}${serverParams({
        check: input.healthcheck,
        weight: server.weight,
        // Die Cookie-Marke ist der Servername und nichts Eigenes. HAProxy
        // schickt den Wert aus dem Cookie an den Server, der so heißt — ein
        // zweiter Name daneben wäre eine zweite Quelle für dieselbe Zuordnung.
        cookie: input.sticky ? name : null,
        tls: input.backendTls,
        checkSni: backendCheckSni(input.healthcheck, input.backendTls, input.domains[0]),
      })}`
    );
  });

  for (const route of input.routes) {
    lines.push(...renderRouteBackend(input, route));
  }

  return lines;
}

/**
 * Der Backend-Block einer Pfad-Regel.
 *
 * **Ohne eigenen `# AUTO:`-Kommentar.** Der steht einmal über der Gruppe, und
 * das ist der Punkt: die Blöcke eines Dienstes gehören zusammen. Ein Kommentar
 * je Block las sich beim Nachsehen von Hand wie drei einzelne Dienste, die
 * zufällig ähnlich heißen — und genau das sind sie nicht.
 *
 * Ohne `option httpchk`, anders als beim Dienst selbst: hinter einer Pfad-Regel
 * steht typischerweise eine WebSocket-Strecke, und die antwortet auf ein
 * `GET /` nicht mit 200. Ein HTTP-Healthcheck nähme sie damit dauerhaft aus dem
 * Betrieb. `check` allein ist eine TCP-Verbindungsprüfung und beantwortet die
 * Frage, die hier zu beantworten ist: nimmt der Port Verbindungen an.
 */
export function renderRouteBackend(input: CreateServiceInput, route: RouteInput): string[] {
  const lines = [
    '',
    `backend ${routeBackendFor(input.id, route.name)}`,
    ...addonBlock(input),
  ];

  const names = serverNames(route.servers);
  route.servers.forEach((server, position) => {
    const name = names[position];
    // Ohne Cookie-Marke und ohne Gewichtung: beides gehört zum eigenen Backend
    // des Dienstes und nicht zu den Zielen einer Pfad-Regel. Siehe
    // `RouteServerInput`.
    lines.push(
      `    server ${name} ${server.target}${serverParams({
        check: route.check,
        weight: null,
        cookie: null,
        tls: route.backendTls,
        checkSni: backendCheckSni(route.check, route.backendTls, input.domains[0]),
      })}`
    );
  });

  return lines;
}

/* ── Der Zustand der Ziele ──
 *
 * HAProxy prüft die Backend-Server selbst (`check`), und es weiß deshalb, ob
 * eines gerade antwortet. Herausbekommen lässt sich das nur über den
 * Stats-Socket: `show stat` gibt eine CSV mit einer Zeile je Server.
 *
 * Der Pfad wird NICHT geraten, sondern aus derselben Konfiguration gelesen, die
 * ohnehin schon im Speicher liegt. Fehlt die Zeile, gibt es keinen Zustand —
 * und dann steht auf der Karte auch keiner. Eine erfundene grüne Anzeige wäre
 * hier die teuerste Sorte Lüge: Sie behauptet, jemand hätte nachgesehen.
 */

/** Der Unix-Socket aus `stats socket …`, ohne seine Parameter. `null` heißt:
 *  nicht eingerichtet. Ein Socket über TCP (`ipv4@…`) zählt nicht: gelesen
 *  wird über das geteilte Verzeichnis, also nur ein Pfad. */
export function parseStatsSocket(text: string): string | null {
  for (const raw of text.split('\n')) {
    const match = /^stats\s+socket\s+(\S+)/.exec(clean(raw));
    if (!match) continue;
    const path = match[1];
    if (path.startsWith('/')) return path;
  }
  return null;
}

/** Der Zustand eines Backend-Servers, wie `show stat` ihn meldet. */
export interface BackendServerState {
  backend: string;
  server: string;
  /** `UP`, `DOWN`, `NOLB`, `MAINT`, `no check` … unverändert von HAProxy. */
  status: string;
}

/**
 * Die CSV von `show stat` in Zeilen.
 *
 * Die Spalten werden über die Kopfzeile gefunden und nicht über ihre Nummer:
 * HAProxy hängt zwischen den Versionen Spalten an, und die 18. ist nicht in
 * jeder Fassung dieselbe.
 */
export function parseStatsCsv(csv: string): BackendServerState[] {
  const lines = csv.split('\n').filter((line) => line.trim() !== '');
  const header = lines.find((line) => line.startsWith('#'));
  if (!header) return [];

  const columns = header.replace(/^#\s*/, '').split(',');
  const px = columns.indexOf('pxname');
  const sv = columns.indexOf('svname');
  const st = columns.indexOf('status');
  if (px === -1 || sv === -1 || st === -1) return [];

  const states: BackendServerState[] = [];
  for (const line of lines) {
    if (line.startsWith('#')) continue;
    const cells = line.split(',');
    const server = cells[sv];
    // `FRONTEND` und `BACKEND` sind die Sammelzeilen des Proxys, keine Server.
    if (!server || server === 'FRONTEND' || server === 'BACKEND') continue;
    states.push({ backend: cells[px], server, status: cells[st] });
  }
  return states;
}

export type ServiceHealth = 'up' | 'down' | 'partial' | 'unknown';

/**
 * Der Zustand eines Dienstes aus den Zuständen seiner Server.
 *
 * Gerechnet wird über ALLE Backends des Eintrags, auch die der Pfad-Regeln: ein
 * totes Terminal-Backend ist ein Teil des Dienstes, der nicht antwortet.
 *
 * `no check` zählt nicht mit. Ein Server ohne Healthcheck wird von HAProxy
 * nicht geprüft, über ihn ist also nichts bekannt — und „unbekannt" ist nicht
 * „in Ordnung".
 */
export function serviceHealth(
  service: Pick<HaproxyService, 'id' | 'routes'>,
  states: BackendServerState[]
): ServiceHealth {
  const own = new Set([service.id, ...service.routes.map((route) => route.backend)]);
  const relevant = states.filter((s) => own.has(s.backend) && s.status !== 'no check');
  if (relevant.length === 0) return 'unknown';

  const up = relevant.filter((s) => s.status.startsWith('UP')).length;
  if (up === relevant.length) return 'up';
  if (up === 0) return 'down';
  return 'partial';
}

/* ── Globale Einstellungen ──
 *
 * Was für ALLE Dienste des Proxys gilt und deshalb in keinen Dienst-Dialog
 * gehört: der Block hinter `# Globale HTTPS-Settings` im Frontend und die
 * Admin-Adressliste.
 *
 * Die Umleitung aus `backend default_404` gehört bewusst nicht dazu: der
 * Fehlerfall wird mit einer eigenen Fehlerdatei bedient, und ein Feld, das
 * eine Zeile überschreibt, die sonst niemand über HAPM pflegt, ist nur ein
 * Weg, sie versehentlich zu ändern.
 *
 * Warum überhaupt hier und nicht von Hand in der Datei: es sind genau die
 * Zeilen, die man einmal setzt und danach nie wieder ansieht — und die dann
 * fehlen, wenn der Proxy neu aufgesetzt wurde. Auf der Seite steht, was gilt.
 *
 * Der Block ist reiner Text: eine Liste HAProxy-Zeilen, die so zurückgeschrieben
 * werden, wie sie hereinkommen. Ein Formular aus Schaltern für bekannte Zeilen
 * scheitert an jeder Zeile daneben (ein `X-Content-Type-Options`, ein eigenes
 * `X-Forwarded-For`): es verlöre sie beim Speichern, also müsste der ganze
 * Block unbearbeitbar werden. Genau die Zeilen, die man hier setzt, sind aber
 * die, die niemand vorhersagen kann. Also wird nichts gedeutet: was in der
 * Datei steht, steht im Formular, und was im Formular steht, steht danach in
 * der Datei. */

export const HTTPS_MARKER = '# Globale HTTPS-Settings';

/* ── Admin-IPs ──
 *
 * EINE ACL je Frontend, und jeder gesperrte Dienst verweist darauf. Nicht eine
 * Liste je Eintrag: dieselben Adressen an dreißig Stellen sind dreißig Stellen,
 * die auseinanderlaufen, sobald sich eine Büro-IP ändert. Wer die Liste hier
 * ändert, ändert sie überall.
 *
 * Die Sperre selbst ist eine `http-request deny`-Regel je Dienst. HAProxy wertet
 * alle `http-request`-Regeln aus, bevor es überhaupt ein Backend wählt — die
 * Regel wirkt also unabhängig davon, wo im Frontend sie steht. Die ACL dagegen
 * muss VOR ihrer ersten Verwendung deklariert sein, sonst lehnt HAProxy die
 * Datei mit „unknown acl" ab. Deshalb steht sie am Kopf des Frontends und nicht
 * beim ersten Dienst, der sie braucht.
 */
export const ADMIN_ACL = 'admin_ips';
export const ADMIN_MARKER = '# Admin-IPs';

/** Die Sperre eines Dienstes, wie dieses Modul sie schreibt. 403 und nicht 404:
 *  „gibt es, darfst du nicht" ist die Wahrheit, und ein 404 an dieser Stelle
 *  schickt einen ausgesperrten Kollegen auf Fehlersuche in die falsche Richtung. */
export function lockRuleFor(aclName: string): string {
  return `http-request deny deny_status 403 if ${aclName} !${ADMIN_ACL}`;
}

/**
 * Die ACL für eine TEILWEISE Sperre: nur einzelne Domains eines Eintrags.
 *
 * Ein Dienst kann `kunde.example` und `intern.kunde.example` bedienen, und gesperrt
 * gehört oft nur die zweite. Über die Host-ACL des Dienstes ginge das nicht —
 * die trägt alle Domains. Deshalb eine zweite ACL mit genau den gesperrten,
 * und die Deny-Regel zeigt darauf.
 *
 * Sind ALLE Domains gesperrt, wird sie nicht geschrieben: dann tut es die
 * Host-ACL, und es bleibt bei einer ACL je Eintrag.
 */
export function lockAclFor(id: string): string {
  return `lock_${id}`;
}

/* ── Die Passwortsperre ──
 *
 * Die zweite Art, eine Domain zu sperren: statt auf die Admin-IPs zu prüfen,
 * zeigt HAProxy eine Passwortabfrage. Wer das Passwort eingibt, bekommt einen
 * Cookie und kommt damit durch.
 *
 * Alles daran erledigt HAProxy selbst. HAPM schreibt die Zeilen und ist
 * danach nicht mehr beteiligt: eine gesperrte Seite soll nicht davon abhängen,
 * ob HAPM gerade läuft.
 *
 * Was je gesperrtem Eintrag in der Datei steht:
 *
 *  - eine ACL auf den Cookie (`pass_<id>`), die den Durchlass erkennt,
 *  - sechs Regeln im Frontend (`passwordLockRules`),
 *  - eine `stick-table` im eigenen Backend, die die Versuche je Adresse zählt.
 *
 * ── Warum SHA-256 und kein langsamer Hash ──
 *
 * HAProxy kann ein Formularfeld nur mit seinen eigenen Konvertern prüfen, und
 * darunter gibt es kein bcrypt. Der Hash ist gesalzen; mehr gibt die Maschine
 * nicht her. Der Preis ist klein: wer `haproxy.cfg` lesen kann, braucht das
 * Passwort ohnehin nicht, denn der Cookie-Wert steht in derselben Datei. Gegen
 * Raten von außen hilft die Zählung der Versuche, nicht der Hash.
 *
 * ── Der Cookie-Wert ist je Eintrag fest ──
 *
 * Alle, die das Passwort kennen, tragen denselben Wert. Er entsteht mit dem
 * Passwort neu: ein geändertes Passwort meldet damit alle ab.
 *
 * Geprüft gegen HAProxy 2.4, 2.8 und 3.0. Ältere kennen `wait-for-body` nicht,
 * siehe `supportsPasswordLock`.
 */

/** Was die Passwortsperre eines Eintrags in der Datei ausmacht. */
export interface PasswordLock {
  /** 32 Hex-Zeichen, an das Passwort angehängt, bevor gehasht wird. */
  salt: string;
  /** SHA-256 über Passwort + Salz, 64 Hex-Zeichen klein. */
  hash: string;
  /** Der Wert des Cookies nach richtiger Eingabe, 64 Hex-Zeichen. */
  token: string;
}

/**
 * „Das Passwort, das schon in der Datei steht."
 *
 * Der Browser bekommt Hash und Cookie-Wert nie zu sehen, muss einen Eintrag
 * aber vollständig zurückschicken können (`toCreateInput`). Dafür steht dieser
 * Wert an ihrer Stelle; `replaceService` setzt beim Schreiben wieder ein, was
 * in der Datei steht.
 */
export const KEEP_PASSWORD = 'unchanged';
/**
 * „Die Art der Sperre bleibt, wie sie ist."
 *
 * Für einen Aufrufer, der das Feld gar nicht schickt. Über `/api/internal`
 * ändert ein anderer Dienst einen Eintrag als GET, ändern, PATCH, und er baut
 * den Rumpf aus den Feldern, die er kennt. Ein fehlendes `passwordLock` als
 * „keine Passwortsperre" zu lesen hieße: wer eine Backend-Adresse ändert,
 * stellt nebenbei eine Passwortsperre auf die Admin-IPs um, und alle mit
 * Passwort stehen vor einem 403. Deshalb: was nicht dasteht, bleibt stehen,
 * dieselbe Regel wie bei `readGlobalSettingsPatch`.
 *
 * Anders als `KEEP_PASSWORD` ist es keine Forderung: steht kein Passwort da,
 * ist es die Sperre auf Admin-IPs wie bisher.
 */
export const INHERIT_LOCK = 'inherit';
export type PasswordLockInput = PasswordLock | typeof KEEP_PASSWORD | typeof INHERIT_LOCK;

/** Wo die drei Seiten der Abfrage auf der Maschine liegen. HAProxy liest sie
 *  beim Laden der Konfiguration ein, nicht bei jeder Anfrage. */
export const LOCK_PAGE_DIR = '/etc/haproxy/hapm-lock';
export const LOCK_PAGE_FILES = {
  ask: 'lock.html',
  wrong: 'lock-wrong.html',
  throttled: 'lock-throttled.html',
} as const;
/** Der Name des Passwortfelds im Formular der Seite. */
export const LOCK_FIELD = 'hapm_lock_password';
/** Wie lange der Cookie gilt: 30 Tage, in Sekunden. */
export const LOCK_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
/** Wie viele Eingaben eine Adresse in zehn Minuten hat, bevor 429 kommt. */
export const LOCK_MAX_ATTEMPTS = 10;
/**
 * Die Zählung der Versuche, im Backend des Eintrags.
 *
 * Im eigenen Backend und nicht in einem gemeinsamen Abschnitt: so geht sie beim
 * Löschen von selbst mit, und es gibt keinen Block, von dem man wissen müsste,
 * wer ihn noch braucht. `ipv6` fasst auch IPv4-Adressen.
 */
export const LOCK_TABLE_LINE = 'stick-table type ipv6 size 10k expire 10m store http_req_rate(10m)';

export function passAclFor(id: string): string {
  return `pass_${id}`;
}

export function lockCookieFor(id: string): string {
  return `hapm_lock_${id}`;
}

const LOCK_SALT = /^[0-9a-f]{32}$/;
const LOCK_DIGEST = /^[0-9a-f]{64}$/;

export function isValidPasswordLock(lock: PasswordLock): boolean {
  return (
    typeof lock === 'object' &&
    lock !== null &&
    LOCK_SALT.test(String(lock.salt)) &&
    LOCK_DIGEST.test(String(lock.hash)) &&
    LOCK_DIGEST.test(String(lock.token))
  );
}

/** Kürzer ist als Sperre für eine öffentlich erreichbare Seite zu wenig, auch
 *  mit gezählten Versuchen. */
export const LOCK_PASSWORD_MIN = 8;
/** Die Abfrage wartet auf höchstens 4 KB Rumpf, und ein Zeichen kann darin bis
 *  zu zwölf Bytes belegen (vier in UTF-8, jedes als `%XX`). 128 Zeichen passen
 *  sicher hinein. */
export const LOCK_PASSWORD_MAX = 128;

/**
 * Das Passwort einer Sperre prüfen. Gibt die Meldung zurück, die der Benutzer
 * lesen soll, oder `null`. Hier und nicht bei der Hash-Bildung, weil Dialog und
 * Route dieselbe Funktion aufrufen.
 */
export function validateLockPassword(password: string): Message | null {
  const length = [...password].length;
  if (length < LOCK_PASSWORD_MIN) {
    return msg('Das Passwort der Sperre braucht mindestens {min} Zeichen.', { min: LOCK_PASSWORD_MIN });
  }
  if (length > LOCK_PASSWORD_MAX) {
    return msg('Das Passwort der Sperre darf höchstens {max} Zeichen lang sein.', { max: LOCK_PASSWORD_MAX });
  }
  // Ein Zeilenumbruch oder Tabulator lässt sich in ein Passwortfeld nicht
  // eintippen. Stünde er im Hash, käme nie jemand durch.
  const isControl = (ch: string) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f;
  if ([...password].some(isControl)) {
    return msg('Das Passwort der Sperre darf keine Steuerzeichen enthalten.');
  }
  return null;
}

/** Die ACL, die den Durchlass erkennt. Vergleich auf den ganzen Wert. */
export function passAclLine(id: string, lock: PasswordLock): string {
  return `acl ${passAclFor(id)} req.cook(${lockCookieFor(id)}) -m str ${lock.token}`;
}

/**
 * Die sechs Regeln der Passwortsperre, in der Reihenfolge, in der HAProxy sie
 * prüft. `target` ist die ACL der gesperrten Domains: die Host-ACL oder
 * `lock_<id>`, wie bei der Sperre auf Admin-IPs.
 *
 * Alle greifen nur ohne gültigen Cookie. Wer durchgelassen ist, erreicht das
 * Ziel, als gäbe es die Sperre nicht, auch mit einem POST.
 *
 *  1. Den Versuch zählen. `sc2`, weil eine von Hand geschriebene Zählung im
 *     selben Frontend am ehesten `sc0` belegt.
 *  2. Zu viele Versuche: 429. Mit benannter Tabelle, damit ein fremder Zähler
 *     auf `sc2` hier keine falsche Sperre auslöst.
 *  3. Auf den Rumpf warten, sonst ist das Formularfeld noch nicht da.
 *  4. Richtiges Passwort: Cookie setzen und auf dieselbe Adresse zurück. Die
 *     Adresse ist vollständig und fest `https://`, weil ein Pfad wie
 *     `//fremd.example` als `Location` sonst auf eine fremde Seite zeigte.
 *  5. Jede andere Eingabe: die Seite mit dem Hinweis.
 *  6. Alles Übrige: die Abfrage.
 */
export function passwordLockRules(id: string, target: string, lock: PasswordLock): string[] {
  const open = `${target} !${passAclFor(id)}`;
  const page = (status: number, file: string, condition: string) =>
    `http-request return status ${status} content-type "text/html; charset=utf-8" ` +
    `hdr Cache-Control no-store file ${LOCK_PAGE_DIR}/${file} if ${condition}`;
  const cookie = `${lockCookieFor(id)}=${lock.token}; Path=/; Max-Age=${LOCK_COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;

  return [
    `http-request track-sc2 src table ${id} if ${open} METH_POST`,
    page(
      429,
      LOCK_PAGE_FILES.throttled,
      `${open} METH_POST { sc_http_req_rate(2,${id}) gt ${LOCK_MAX_ATTEMPTS} }`
    ),
    `http-request wait-for-body time 5s at-least 4k if ${open} METH_POST`,
    `http-request return status 303 hdr Location https://%[req.hdr(host)]%[pathq] ` +
      `hdr Cache-Control no-store hdr Set-Cookie "${cookie}" if ${open} METH_POST ` +
      `{ req.body_param(${LOCK_FIELD}),url_dec(1),concat(${lock.salt}),sha2(256),hex,lower -m str ${lock.hash} }`,
    page(401, LOCK_PAGE_FILES.wrong, `${open} METH_POST`),
    page(401, LOCK_PAGE_FILES.ask, open),
  ];
}

/** Salz und Hash stehen nur in der vierten Regel. */
const LOCK_UNLOCK_RULE = /,concat\(([0-9a-f]+)\),sha2\(256\),hex,lower -m str ([0-9a-f]+) \}$/;

/**
 * Die Passwortsperre aus den Zeilen eines Eintrags zurücklesen.
 *
 * Wie die Sitzungsbindung zählt sie nur vollständig: aus Cookie-ACL und vierter
 * Regel entsteht ein Kandidat, und der gilt erst, wenn alle sechs Regeln Wort
 * für Wort so dastehen, wie `passwordLockRules` sie für ihn schriebe. Eine
 * halbe Sperre ist keine, und neu geschrieben wäre sie eine ganze.
 */
function readPasswordLock(
  id: string,
  target: string,
  ruleTexts: string[],
  passAclTexts: string[]
): PasswordLock | null {
  if (passAclTexts.length !== 1) return null;
  const token = passAclTexts[0].split(/\s+/).pop() ?? '';

  for (const text of ruleTexts) {
    const match = LOCK_UNLOCK_RULE.exec(text);
    if (!match) continue;
    const lock: PasswordLock = { salt: match[1], hash: match[2], token };
    if (!isValidPasswordLock(lock) || passAclTexts[0] !== passAclLine(id, lock)) continue;
    if (passwordLockRules(id, target, lock).every((rule) => ruleTexts.includes(rule))) return lock;
  }
  return null;
}

/**
 * Die Passwortsperre einer Eingabe, wie sie geschrieben wird.
 *
 * `KEEP_PASSWORD` darf hier nicht mehr ankommen: es ist ein Verweis auf den
 * Stand in der Datei, und den kennt nur `replaceService`.
 */
function passwordLockOf(input: CreateServiceInput): PasswordLock | null {
  // Ohne Stand in der Datei gibt es nichts zu erben: ein neuer Eintrag mit
  // gesperrten Domains und ohne Angabe ist die Sperre auf Admin-IPs.
  if (input.passwordLock === INHERIT_LOCK) return null;
  if (input.passwordLock === KEEP_PASSWORD) {
    throw new HaproxyConfigError(
      msg('Für die Passwortsperre von "{id}" ist kein Passwort gesetzt.', { id: input.id })
    );
  }
  return input.lockedDomains.length > 0 ? input.passwordLock : null;
}

/**
 * Derselbe Eintrag ohne Salz, Hash und Cookie-Wert, für den Weg zum Browser.
 *
 * Der Cookie-Wert ist der Durchlass selbst. In einer Antwort, die im Browser
 * liegen bleibt, hat er nichts verloren, auch nicht bei jemandem, der sich
 * anmelden darf.
 */
export function withoutLockSecret(service: HaproxyService): HaproxyService {
  return service.passwordLock === null ? service : { ...service, passwordLock: KEEP_PASSWORD };
}

/**
 * Ob diese HAProxy-Version die Passwortsperre kann. `null` heißt unbekannt:
 * dann entscheidet `haproxy -c` im Vorgang.
 *
 * Die Grenze ist 2.4, weil `http-request wait-for-body` dort dazukam. Ohne das
 * Warten ist der Rumpf beim Prüfen noch nicht gelesen, und jedes Passwort gälte
 * als falsch.
 */
export function supportsPasswordLock(version: string | null): boolean | null {
  const match = /^(\d+)\.(\d+)/.exec(version ?? '');
  if (!match) return null;
  const major = Number(match[1]);
  return major > 2 || (major === 2 && Number(match[2]) >= 4);
}

/**
 * Ob dieses HAProxy `ca-file @system-ca` kennt, die CAs des Systems. `null`
 * heißt unbekannt, dann entscheidet `haproxy -c` im Vorgang.
 *
 * Die Grenze ist 2.6: im Handbuch von 2.4 fehlt `@system-ca`, in dem von 2.6
 * steht es (2.5 ist keine LTS-Fassung und nicht nachgesehen). Das offizielle
 * Abbild bringt `ca-certificates` dafür mit.
 */
export function supportsSystemCa(version: string | null): boolean | null {
  const match = /^(\d+)\.(\d+)/.exec(version ?? '');
  if (!match) return null;
  const major = Number(match[1]);
  return major > 2 || (major === 2 && Number(match[2]) >= 6);
}

/** Ob eine Eingabe irgendwo `verify` verlangt, im Backend oder in einer Regel. */
export function usesSystemCa(input: Pick<CreateServiceInput, 'backendTls' | 'routes'>): boolean {
  return input.backendTls === 'verify' || input.routes.some((route) => route.backendTls === 'verify');
}

/** Ob diese Konfiguration die Seiten der Abfrage braucht. Sie müssen auf der
 *  Maschine liegen, bevor `haproxy -c` die Datei liest. */
export function usesLockPages(text: string): boolean {
  return text.includes(`${LOCK_PAGE_DIR}/`);
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/(\d{1,2}))?$/;
const IPV6 = /^[0-9a-fA-F:]{2,}(\/(\d{1,3}))?$/;

/** Eine Adresse oder ein Netz, wie `src` sie vergleicht. */
export function isValidSourceAddress(value: string): boolean {
  const v4 = IPV4.exec(value);
  if (v4) {
    const octets = [v4[1], v4[2], v4[3], v4[4]].map(Number);
    if (octets.some((o) => o > 255)) return false;
    return v4[6] === undefined || Number(v4[6]) <= 32;
  }
  const v6 = IPV6.exec(value);
  if (v6 && value.includes(':')) {
    return v6[2] === undefined || Number(v6[2]) <= 128;
  }
  return false;
}

export interface GlobalSettings {
  /** Die Zeilen unter dem Marker, so wie sie dastehen (ohne Einrückung).
   *  `null` heißt: den Marker gibt es in dieser Konfiguration nicht. Dann wird
   *  nichts angeboten — einen Block anzulegen, den es nie gab, hieße raten, wo
   *  im Frontend er hingehört. */
  httpsLines: string[] | null;
  /** Die Adressen aus `acl admin_ips src …`. Leer heißt: keine gesetzt, und
   *  damit lässt sich kein Dienst sperren. */
  adminIps: string[];
  /** Steht die ACL mehr als einmal da, wird sie nicht angefasst: HAProxy
   *  verodert sie, und ein Zusammenschreiben wäre eine Änderung, die niemand
   *  angefordert hat. */
  adminEditable: boolean;
  /** Die Dienste, die gerade nur für diese Adressen erreichbar sind. Der Grund
   *  fürs Mitlesen: die Liste zu leeren, während einer davon gesperrt ist,
   *  macht die Konfiguration ungültig. */
  lockedServices: string[];
  /** Der Block unter `# Zugriffsschutz`. Ohne Block: alles leer. `null` heißt:
   *  der Block steht da, aber nicht so, wie HAPM ihn schreibt. Dann wird er
   *  nicht angefasst, siehe `parseProtection`. */
  protection: AccessProtection | null;
  /** Ob CrowdSec jede Anfrage des HTTPS-Frontends prüft (Block unter
   *  `# CrowdSec`). `null` heißt: der Block steht da, aber nicht so, wie HAPM
   *  ihn schreibt. Er wirkt dann weiter und wird nicht angefasst. */
  crowdsec: boolean | null;
}

export interface GlobalSettingsInput {
  httpsLines: string[];
  adminIps: string[];
  /** Fehlt das Feld, bleibt der Zugriffsschutz, wie er ist. Neu geschrieben
   *  wird der Block trotzdem, weil seine Ausnahme für die Admin-IPs an der
   *  Adressliste hängt. */
  protection?: AccessProtection;
  /** Fehlt das Feld, bleibt CrowdSec im Frontend, wie es ist. */
  crowdsec?: boolean;
}

/* ── Zugriffsschutz ──
 *
 * Drei Sperren, die für JEDEN Dienst im HTTPS-Frontend gelten: einzelne
 * Adressen und Netze, ganze Länder und eine Ratenbegrenzung je Adresse. Sie
 * stehen als ein Block unter `# Zugriffsschutz` direkt hinter den `bind`-Zeilen
 * (hinter `acl admin_ips`, wenn es die gibt), also vor jeder Regel der Dienste.
 *
 * Nur im HTTPS-Frontend. Im HTTP-Frontend liegt die ACME-Prüfung, und Let's
 * Encrypt prüft von Rechnern in mehreren Ländern aus. Eine Ländersperre dort
 * ließe HTTP-01 scheitern. Wer über HTTP kommt, wird ohnehin nach HTTPS
 * umgeleitet und trifft dort auf die Sperre.
 *
 * Wie die Passwortsperre läuft das ohne HAPM: HAProxy liest die Länderlisten
 * beim Laden aus Dateien (`GEO_BLOCK_DIR`, eine je Land, erzeugt aus der
 * GeoIP-Tabelle in `lib/geoip/networks.ts`) und zählt die Anfragen in einer
 * eigenen `stick-table` des Frontends.
 *
 * Die Admin-IPs sind von der Länder- und der Ratensperre ausgenommen, sonst
 * sperrt sich aus, wer auf Reisen ist oder die Oberfläche lädt (sie läuft über
 * dasselbe HAProxy). Von der Sperre einzelner Adressen nicht: wer eine Adresse
 * ausdrücklich sperrt, meint sie.
 */

export const PROTECTION_MARKER = '# Zugriffsschutz';
export const BLOCKED_IPS_ACL = 'hapm_blocked_ips';
export const BLOCKED_COUNTRIES_ACL = 'hapm_blocked_countries';
export const GEO_BLOCK_DIR = '/etc/haproxy/hapm-geo';

export const RATE_PERIODS = ['10s', '1m', '10m'] as const;
export type RatePeriod = (typeof RATE_PERIODS)[number];

export interface RateLimit {
  /** Mehr Anfragen als diese im Zeitraum bekommen 429. */
  requests: number;
  period: RatePeriod;
}

export interface AccessProtection {
  blockedIps: string[];
  /** ISO-Codes aus zwei Großbuchstaben, sortiert. */
  blockedCountries: string[];
  /** `null` heißt: keine Begrenzung. */
  rateLimit: RateLimit | null;
}

export const EMPTY_PROTECTION: AccessProtection = { blockedIps: [], blockedCountries: [], rateLimit: null };

export const RATE_LIMIT_MIN = 10;
export const RATE_LIMIT_MAX = 100_000;
/** Der Vorschlag beim Einschalten. Eine Seite mit vielen Dateien lädt beim
 *  ersten Aufruf leicht hundert auf einmal, und mehrere Menschen hinter
 *  einem Anschluss teilen sich eine Adresse. */
export const RATE_LIMIT_DEFAULT: RateLimit = { requests: 300, period: '10s' };

/** Wie lange eine Adresse ohne Anfrage in der Tabelle bleibt: das Doppelte des
 *  Zeitraums, damit die Rate über den ganzen Zeitraum gezählt wird. */
const RATE_EXPIRE: Record<RatePeriod, string> = { '10s': '20s', '1m': '2m', '10m': '20m' };

/** HAProxy liest höchstens 64 Wörter je Zeile und schneidet den Rest mit einer
 *  Warnung ab. Lange Listen gehen deshalb auf mehrere Zeilen mit demselben
 *  ACL-Namen, die HAProxy verodert. */
const ACL_VALUES_PER_LINE = 40;

export function geoBlockFile(country: string): string {
  return `${GEO_BLOCK_DIR}/${country}.lst`;
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Die Zeilen des Blocks ohne Marker und Einrückung. Leer heißt: kein Block. */
export function protectionLines(protection: AccessProtection, adminExempt: boolean): string[] {
  const unlessAdmin = adminExempt ? ` !${ADMIN_ACL}` : '';
  const out: string[] = [];

  if (protection.blockedIps.length > 0) {
    for (const part of chunks(protection.blockedIps, ACL_VALUES_PER_LINE)) {
      out.push(`acl ${BLOCKED_IPS_ACL} src ${part.join(' ')}`);
    }
    out.push(`http-request deny deny_status 403 if ${BLOCKED_IPS_ACL}`);
  }

  if (protection.blockedCountries.length > 0) {
    // Zwei Wörter je Land (`-f <datei>`).
    for (const part of chunks(protection.blockedCountries, ACL_VALUES_PER_LINE / 2)) {
      out.push(`acl ${BLOCKED_COUNTRIES_ACL} src ${part.map((c) => `-f ${geoBlockFile(c)}`).join(' ')}`);
    }
    out.push(`http-request deny deny_status 403 if ${BLOCKED_COUNTRIES_ACL}${unlessAdmin}`);
  }

  if (protection.rateLimit) {
    const { requests, period } = protection.rateLimit;
    // Die Tabelle gehört dem Frontend selbst und nicht einem eigenen Backend:
    // so geht sie mit dem Block, und es gibt keinen Abschnitt, von dem man
    // wissen müsste, wer ihn noch braucht. Gezählt wird über `sc1`. Die
    // Passwortsperre zählt über `sc2`, Handgeschriebenes am ehesten über `sc0`.
    out.push(
      `stick-table type ipv6 size 100k expire ${RATE_EXPIRE[period]} store http_req_rate(${period})`,
      'http-request track-sc1 src',
      `http-request deny deny_status 429 if { sc_http_req_rate(1) gt ${requests} }${unlessAdmin}`
    );
  }
  return out;
}

/** Marker und die Zeilen darunter bis zur nächsten Leerzeile, dem nächsten
 *  Kommentar oder Abschnitt, wie beim Block der HTTPS-Einstellungen. */
export function protectionBlockRange(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((line) => clean(line) === PROTECTION_MARKER);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length) {
    const line = clean(lines[end]);
    if (line === '' || line.startsWith('#') || SECTION_KEYWORDS.test(line)) break;
    end++;
  }
  return { start, end };
}

/**
 * Den Block lesen. Er zählt nur vollständig, wie die Passwortsperre: aus den
 * Zeilen entsteht ein Kandidat, und er gilt erst, wenn er neu geschrieben
 * Zeile für Zeile so dasteht. Eine von Hand geänderte Zahl oder eine fremde
 * Zeile im Block machen ihn unlesbar (`null`), und dann wird er nicht
 * angefasst. Sonst würde aus einer Regel, die jemand bewusst anders
 * geschrieben hat, beim nächsten Speichern still die von HAPM.
 */
export function parseProtection(text: string): AccessProtection | null {
  const lines = text.split('\n');
  const range = protectionBlockRange(lines);
  if (!range) return { ...EMPTY_PROTECTION };

  const body: string[] = [];
  for (let i = range.start + 1; i < range.end; i++) body.push(clean(lines[i]));

  const candidate: AccessProtection = { blockedIps: [], blockedCountries: [], rateLimit: null };
  const ipAcl = new RegExp(`^acl\\s+${BLOCKED_IPS_ACL}\\s+src\\s+(.+)$`);
  const countryAcl = new RegExp(`^acl\\s+${BLOCKED_COUNTRIES_ACL}\\s+src\\s+(.+)$`);
  const table = /^stick-table\s.*\shttp_req_rate\((\S+)\)$/;
  const rate = /^http-request\s+deny\s+deny_status\s+429\s+if\s+\{\s*sc_http_req_rate\(1\)\s+gt\s+(\d+)\s*\}/;

  let period: string | null = null;
  let requests: number | null = null;
  for (const line of body) {
    let match = ipAcl.exec(line);
    if (match) {
      candidate.blockedIps.push(...match[1].split(/\s+/).filter(Boolean));
      continue;
    }
    match = countryAcl.exec(line);
    if (match) {
      const words = match[1].split(/\s+/).filter(Boolean);
      for (let i = 0; i < words.length; i += 2) {
        const file = new RegExp(`^${GEO_BLOCK_DIR}/([A-Z]{2})\\.lst$`).exec(words[i + 1] ?? '');
        if (words[i] !== '-f' || !file) return null;
        candidate.blockedCountries.push(file[1]);
      }
      continue;
    }
    match = table.exec(line);
    if (match) {
      period = match[1];
      continue;
    }
    match = rate.exec(line);
    if (match) requests = Number(match[1]);
  }

  if (period !== null || requests !== null) {
    if (!(RATE_PERIODS as readonly string[]).includes(period ?? '') || requests === null) return null;
    candidate.rateLimit = { requests, period: period as RatePeriod };
  }

  const same = (expected: string[]) =>
    expected.length === body.length && expected.every((line, i) => line === body[i]);
  if (same(protectionLines(candidate, true)) || same(protectionLines(candidate, false))) {
    return candidate;
  }
  return null;
}

/** Die Länder, deren Listen die Konfiguration lädt. Gelesen aus jeder Zeile
 *  der ACL, auch aus einem Block, der sonst nicht lesbar ist: die Dateien
 *  müssen liegen, sobald eine Zeile auf sie zeigt, sonst lehnt HAProxy die
 *  ganze Konfiguration ab. */
export function geoBlockCountries(text: string): string[] {
  const found = new Set<string>();
  const acl = new RegExp(`^acl\\s+${BLOCKED_COUNTRIES_ACL}\\s`);
  const file = new RegExp(`${GEO_BLOCK_DIR}/([A-Z]{2})\\.lst`, 'g');
  for (const raw of text.split('\n')) {
    const line = clean(raw);
    if (!acl.test(line)) continue;
    for (const match of line.matchAll(file)) found.add(match[1]);
  }
  return [...found].sort();
}

/** Ob eine Konfiguration überhaupt etwas sperrt. Für die Anzeige. */
export function protectionActive(protection: AccessProtection | null): boolean {
  return (
    protection !== null &&
    (protection.blockedIps.length > 0 || protection.blockedCountries.length > 0 || protection.rateLimit !== null)
  );
}

export function validateProtection(protection: AccessProtection): Message | null {
  const seen = new Set<string>();
  for (const address of protection.blockedIps) {
    if (!isValidSourceAddress(address)) {
      return msg('Keine gültige Adresse: {address}. Erwartet wird eine IP oder ein Netz wie 10.0.0.0/8.', { address });
    }
    if (seen.has(address)) return msg('Die Adresse {address} steht doppelt in der Liste.', { address });
    seen.add(address);
  }
  const countries = new Set<string>();
  for (const code of protection.blockedCountries) {
    if (!/^[A-Z]{2}$/.test(code) || code === 'ZZ') {
      return msg('Kein Ländercode: {code}. Erwartet werden zwei Buchstaben wie DE.', { code });
    }
    if (countries.has(code)) return msg('Das Land {code} steht doppelt in der Liste.', { code });
    countries.add(code);
  }
  const limit = protection.rateLimit;
  if (limit) {
    if (!(RATE_PERIODS as readonly string[]).includes(limit.period)) {
      return msg('Unbekannter Zeitraum für die Ratenbegrenzung: {period}.', { period: String(limit.period) });
    }
    if (!Number.isInteger(limit.requests) || limit.requests < RATE_LIMIT_MIN || limit.requests > RATE_LIMIT_MAX) {
      return msg('Die Ratenbegrenzung braucht eine ganze Zahl von {min} bis {max} Anfragen.', {
        min: RATE_LIMIT_MIN,
        max: RATE_LIMIT_MAX,
      });
    }
  }
  return null;
}

/** Aus einem Request-Rumpf, normalisiert und nicht geprüft. `undefined`, wenn
 *  das Feld fehlt. */
export function readProtectionInput(value: unknown): AccessProtection | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const list = (entry: unknown): string[] =>
    Array.isArray(entry) ? entry.map((item) => String(item).trim()).filter(Boolean) : [];
  return {
    blockedIps: list(raw.blockedIps),
    blockedCountries: [...new Set(list(raw.blockedCountries).map((code) => code.toUpperCase()))].sort(),
    rateLimit: readRateLimit(raw.rateLimit),
  };
}

function readRateLimit(value: unknown): RateLimit | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  return { requests: Number(raw.requests), period: String(raw.period) as RatePeriod };
}

/** Wohin ein neuer Block kommt: hinter `acl admin_ips` im HTTPS-Frontend, sonst
 *  hinter dessen letzte `bind`-Zeile. Das HTTPS-Frontend ist das mit dem
 *  Marker der HTTPS-Einstellungen. Die letzte `bind`-Zeile der ganzen Datei
 *  könnte zu einer TCP-Weiterleitung gehören. */
function protectionAnchor(lines: string[]): number | null {
  const marker = lines.findIndex((line) => clean(line) === HTTPS_MARKER);
  if (marker === -1) return null;
  let start = marker;
  while (start > 0 && !SECTION_KEYWORDS.test(clean(lines[start]))) start--;
  let end = marker + 1;
  while (end < lines.length && !SECTION_KEYWORDS.test(clean(lines[end]))) end++;

  let anchor: number | null = null;
  for (let i = start; i < end; i++) {
    const line = clean(lines[i]);
    if (/^bind\s/.test(line) && i < marker) anchor = i;
    if (new RegExp(`^acl\\s+${ADMIN_ACL}\\s`).test(line) && (anchor === null || i > anchor)) anchor = i;
  }
  return anchor;
}

function applyProtectionBlock(
  lines: string[],
  protection: AccessProtection,
  adminExempt: boolean
): string[] {
  let next = [...lines];
  const body = protectionLines(protection, adminExempt);
  let range = protectionBlockRange(next);

  // Eine Regel mit `!admin_ips` vor der ACL wäre „unknown acl". Steht der Block
  // vor der Admin-ACL, wird er dahinter neu eingesetzt.
  if (range && body.length > 0 && adminExempt) {
    const admin = next.findIndex((line) => new RegExp(`^acl\\s+${ADMIN_ACL}\\s`).test(clean(line)));
    if (admin > range.start) {
      next = removeBlock(next, range);
      range = null;
    }
  }

  if (range) {
    if (body.length === 0) return removeBlock(next, range);
    const indent = /^\s*/.exec(next[range.start])?.[0] ?? '    ';
    return [...next.slice(0, range.start + 1), ...body.map((l) => `${indent}${l}`), ...next.slice(range.end)];
  }
  if (body.length === 0) return next;

  const anchor = protectionAnchor(next);
  if (anchor === null) {
    throw new HaproxyConfigError(
      msg(
        'In {file} war keine Stelle für den Zugriffsschutz zu finden: gesucht wird die letzte bind-Zeile des Frontends mit "{marker}".',
        { file: HAPROXY_CFG, marker: HTTPS_MARKER }
      )
    );
  }
  const indent = /^\s*/.exec(next[anchor])?.[0] ?? '    ';
  next.splice(anchor + 1, 0, '', `${indent}${PROTECTION_MARKER}`, ...body.map((l) => `${indent}${l}`));
  return next;
}

/** Wo der CrowdSec-Block im Frontend steht: Marker und die Zeilen darunter bis
 *  zur nächsten Leerzeile, dem nächsten Kommentar oder Abschnitt. */
export function crowdsecBlockRange(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((line) => clean(line) === CROWDSEC_MARKER);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length) {
    const line = clean(lines[end]);
    if (line === '' || line.startsWith('#') || SECTION_KEYWORDS.test(line)) break;
    end++;
  }
  return { start, end };
}

/** `true`: der Block steht vollständig da. `false`: es gibt keinen. `null`:
 *  er steht anders da, als HAPM ihn schreibt (dann bleibt er unberührt). */
export function parseCrowdsecGlobal(text: string): boolean | null {
  const lines = text.split('\n');
  const range = crowdsecBlockRange(lines);
  if (!range) return false;
  const body = lines.slice(range.start + 1, range.end).map(clean);
  return crowdsecComplete(body) ? true : null;
}

/**
 * Den Block setzen oder entfernen. Er steht hinter dem Zugriffsschutz, sonst
 * an dessen Stelle (hinter den `bind`-Zeilen und `acl admin_ips`): eine
 * gesperrte Adresse kostet dann keine Frage an den Bouncer, und vor jeder
 * Regel der Dienste steht er trotzdem.
 */
function applyCrowdsecBlock(lines: string[], on: boolean): string[] {
  const range = crowdsecBlockRange(lines);
  if (range) {
    if (!on) return removeBlock(lines, range);
    const indent = /^\s*/.exec(lines[range.start])?.[0] ?? '    ';
    return [...lines.slice(0, range.start + 1), ...CROWDSEC_LINES.map((l) => `${indent}${l}`), ...lines.slice(range.end)];
  }
  if (!on) return lines;

  const protection = protectionBlockRange(lines);
  const anchor = protection ? protection.end - 1 : protectionAnchor(lines);
  if (anchor === null) {
    throw new HaproxyConfigError(
      msg(
        'In {file} war keine Stelle für CrowdSec zu finden: gesucht wird die letzte bind-Zeile des Frontends mit "{marker}".',
        { file: HAPROXY_CFG, marker: HTTPS_MARKER }
      )
    );
  }
  const indent = /^\s*/.exec(lines[anchor])?.[0] ?? '    ';
  const next = [...lines];
  next.splice(anchor + 1, 0, '', `${indent}${CROWDSEC_MARKER}`, ...CROWDSEC_LINES.map((l) => `${indent}${l}`));
  return next;
}

/** Den Block samt Marker entfernen, mit der Leerzeile davor, die beim
 *  Einfügen dazukam. */
function removeBlock(lines: string[], range: { start: number; end: number }): string[] {
  const blankBefore = range.start > 0 && clean(lines[range.start - 1]) === '' ? 1 : 0;
  return [...lines.slice(0, range.start - blankBefore), ...lines.slice(range.end)];
}

/** Wo der Einstellungsblock steht: Marker-Zeile und die Zeilen darunter bis zur
 *  nächsten Leerzeile, dem nächsten Kommentar oder dem nächsten Abschnitt.
 *  Exportiert für `base-config-diff.ts`: was hier steht, gleicht der Abgleich
 *  der Grundkonfiguration nicht ab. */
export function httpsBlockRange(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((line) => clean(line) === HTTPS_MARKER);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length) {
    const line = clean(lines[end]);
    if (line === '' || line.startsWith('#') || SECTION_KEYWORDS.test(line)) break;
    end++;
  }
  return { start, end };
}

/**
 * Die Zeile, hinter der eine neue `acl admin_ips` eingefügt wird: die letzte
 * `bind`-Zeile vor dem ersten Dienst-Marker.
 *
 * Nicht der HTTPS-Marker, obwohl der bequemer wäre — dann hinge diese Funktion
 * an einer anderen, die es nicht überall gibt. Und nicht einfach „nach
 * `frontend`": zwischen `frontend` und `bind` kann noch Konfiguration
 * stehen, und eine ACL zwischen `frontend` und `bind` wäre zwar gültig,
 * aber an einer Stelle, an der sie niemand sucht.
 */
function adminAnchor(lines: string[]): number | null {
  const firstService = scopeMarkers(lines).find(
    (marker) => marker.edge === 'end' && marker.kind === 'services'
  );
  const limit = firstService?.index ?? lines.length;
  for (let i = limit - 1; i >= 0; i--) {
    if (/^bind\s/.test(clean(lines[i]))) return i;
  }
  return null;
}

/** Alle Zeilen `acl admin_ips src …` samt Position. Mehr als eine heißt: nicht
 *  anfassen, siehe `adminEditable`. */
function adminAclLines(lines: string[]): { index: number; addresses: string[] }[] {
  const found: { index: number; addresses: string[] }[] = [];
  lines.forEach((raw, index) => {
    const match = new RegExp(`^acl\\s+${ADMIN_ACL}\\s+src\\s+(.+)$`).exec(clean(raw));
    if (match) found.push({ index, addresses: match[1].split(/\s+/).filter(Boolean) });
  });
  return found;
}

export function parseGlobalSettings(text: string): GlobalSettings {
  const lines = text.split('\n');
  const admin = adminAclLines(lines);
  const result: GlobalSettings = {
    httpsLines: null,
    adminIps: admin.length === 1 ? admin[0].addresses : admin.flatMap((a) => a.addresses),
    adminEditable: admin.length <= 1,
    lockedServices: parseHaproxyConfig(text)
      // Eine Passwortsperre benutzt die Adressliste nicht und steht dem Leeren
      // deshalb nicht im Weg.
      .filter((service) => service.lockedDomains.length > 0 && service.passwordLock === null)
      .map((service) => service.id),
    protection: parseProtection(text),
    crowdsec: parseCrowdsecGlobal(text),
  };

  const block = httpsBlockRange(lines);
  if (block) {
    const body: string[] = [];
    for (let i = block.start + 1; i < block.end; i++) {
      body.push(clean(lines[i]));
    }
    result.httpsLines = body;
  }

  return result;
}

/**
 * Welche Header das Frontend der Dienste schon für alle Ziele setzt.
 *
 * Das Formular braucht es, weil derselbe Name an einem Ziel zwei verschiedene
 * Dinge bedeutet (geprüft gegen HAProxy 2.4, 2.8 und 3.0):
 *
 *  - `http-request`-Regeln laufen erst im Frontend, dann im Backend. Ein
 *    Header der Anfrage am Ziel ersetzt also den des Frontends.
 *  - `http-response`-Regeln laufen andersherum, erst im Backend, dann im
 *    Frontend. Ein Header der Antwort am Ziel wird vom Frontend wieder
 *    überschrieben und kommt nie beim Besucher an.
 *
 * Gelesen wird der ganze Abschnitt und nicht nur der Block unter dem Marker:
 * `alt-svc` steht in der Grundkonfiguration darüber. Eine Zeile mit Bedingung
 * zählt nicht: ob sie für dieses Ziel greift, weiß hier niemand, und ein
 * Hinweis „kommt nicht an", der nicht stimmt, ist schlechter als keiner.
 */
export function parseGlobalHeaders(text: string): Record<HeaderDirection, string[]> {
  const lines = text.split('\n');
  const found: Record<HeaderDirection, string[]> = { request: [], response: [] };

  let anchor = lines.findIndex((line) => clean(line) === HTTPS_MARKER);
  if (anchor === -1) {
    anchor = scopeMarkers(lines).find((marker) => marker.kind === 'services')?.index ?? -1;
  }
  if (anchor === -1) return found;

  let start = anchor;
  while (start > 0 && !SECTION_KEYWORDS.test(clean(lines[start]))) start--;
  let end = anchor + 1;
  while (end < lines.length && !SECTION_KEYWORDS.test(clean(lines[end]))) end++;

  for (let i = start; i < end; i++) {
    const line = clean(lines[i]);
    const match = /^http-(request|response)\s+set-header\s+(\S+)/.exec(line);
    if (!match || /\s(if|unless)\s/.test(line)) continue;
    const list = found[match[1] as HeaderDirection];
    if (!list.some((name) => name.toLowerCase() === match[2].toLowerCase())) list.push(match[2]);
  }
  return found;
}

/**
 * Das `timeout tunnel` aus dem `defaults`-Abschnitt, der für die Backends von
 * HAPM gilt, oder `null`.
 *
 * HAProxy wendet auf einen Abschnitt den letzten `defaults` davor an. Gezählt
 * wird deshalb der letzte vor dem ersten Backend-Block einer Gruppe (ohne
 * Gruppe: vor dem ersten `backend`). Steht dort schon eine Zeile, ist der
 * Schalter „Lange Verbindungen“ für jedes Ziel überflüssig: die Zeile im
 * Backend schriebe dieselbe Wirkung ein zweites Mal hin. Ein `timeout tunnel`
 * im Frontend gibt es nicht, HAProxy erlaubt es nur in `defaults`, `listen`
 * und `backend`.
 */
export function parseDefaultsTunnel(text: string): string | null {
  const lines = text.split('\n');
  let limit = scopeMarkers(lines).find((marker) => marker.kind === 'backends')?.index ?? -1;
  if (limit === -1) limit = lines.findIndex((line) => /^backend\s/.test(clean(line)));
  if (limit === -1) limit = lines.length;

  let section = -1;
  for (let i = 0; i < limit; i++) {
    if (/^defaults(\s|$)/.test(clean(lines[i]))) section = i;
  }
  if (section === -1) return null;

  for (let i = section + 1; i < lines.length; i++) {
    const line = clean(lines[i]);
    if (SECTION_KEYWORDS.test(line)) break;
    const match = /^timeout\s+tunnel\s+(\S+)/.exec(line);
    if (match) return match[1];
  }
  return null;
}

/** Ob sich die Einstellungen überhaupt schreiben lassen. Anders als bei einem
 *  Dienst hängt das nicht am Inhalt: der Block ist Text und wird als Text
 *  zurückgeschrieben. Es fehlt nur der Fall, in dem der Marker gar nicht da ist
 *  und damit niemand sagen kann, wo die Zeilen hingehören. */
export function settingsEditable(settings: GlobalSettings): boolean {
  return settings.httpsLines !== null;
}

/**
 * Was eine Zeile im Block nicht sein darf.
 *
 * Nicht der Versuch, HAProxy-Syntax zu prüfen — das tut `haproxy -c` auf der
 * Maschine, und zwar richtig. Abgelehnt wird nur, was den BLOCK zerschneiden
 * würde: der Bereich endet an der ersten Leerzeile, am ersten Kommentar und am
 * nächsten Abschnittswort. Eine solche Zeile stünde nach dem Speichern in der
 * Datei und wäre beim nächsten Lesen nicht mehr Teil des Blocks — alles
 * darunter ebenfalls nicht.
 */
function badSettingsLine(line: string): Message | null {
  if (line.includes('\n')) return msg('Eine Zeile darf keinen Zeilenumbruch enthalten.');
  if (line.startsWith('#')) {
    return msg(
      'Kommentarzeilen gehen hier nicht: "{line}". Der Block endet am ersten Kommentar, alles darunter stünde danach außerhalb.',
      { line }
    );
  }
  if (SECTION_KEYWORDS.test(line)) {
    return msg(
      '"{line}" beginnt einen neuen Konfigurationsabschnitt und beendet damit den Block. Diese Zeile gehört an eine andere Stelle der Datei.',
      { line }
    );
  }
  return null;
}

export function validateGlobalSettings(input: GlobalSettingsInput): Message | null {
  for (const line of input.httpsLines) {
    const bad = badSettingsLine(line);
    if (bad) return bad;
  }
  const seen = new Set<string>();
  for (const address of input.adminIps) {
    if (!isValidSourceAddress(address)) {
      return msg('Keine gültige Adresse: {address}. Erwartet wird eine IP oder ein Netz wie 10.0.0.0/8.', { address });
    }
    if (seen.has(address)) return msg('Die Adresse {address} steht doppelt in der Liste.', { address });
    seen.add(address);
  }
  return input.protection ? validateProtection(input.protection) : null;
}

/**
 * Die Einstellungen zurückschreiben.
 *
 * Ersetzt genau zwei Stellen: die Zeilen unter dem Marker und die Adressliste
 * der Admin-ACL. Alles andere bleibt Zeichen für Zeichen stehen — auch die
 * Einrückung, die aus der jeweils ersten Zeile übernommen wird.
 */
export function applyGlobalSettings(text: string, input: GlobalSettingsInput): string {
  const invalid = validateGlobalSettings(input);
  if (invalid) throw new HaproxyConfigError(invalid);

  const current = parseGlobalSettings(text);
  if (current.httpsLines === null) {
    throw new HaproxyConfigError(
      msg(
        'In {file} fehlt die Zeile "{marker}". Ohne sie ist nicht bestimmbar, wo die globalen Einstellungen stehen.',
        { file: HAPROXY_CFG, marker: HTTPS_MARKER }
      )
    );
  }

  if (!current.adminEditable) {
    throw new HaproxyConfigError(
      msg(
        '"acl {acl} src …" steht mehr als einmal in {file}. HAProxy verodert die Zeilen; sie zu einer zusammenzuschreiben wäre eine Änderung, die niemand angefordert hat.',
        { acl: ADMIN_ACL, file: HAPROXY_CFG }
      )
    );
  }
  // Die Liste zu leeren, während ein Eintrag auf sie zeigt, macht die Datei
  // ungültig — `haproxy -c` würde es fangen, aber erst nachdem der Vorgang
  // gelaufen ist, und die Meldung nennt nur „unknown acl".
  if (input.adminIps.length === 0 && current.lockedServices.length > 0) {
    throw new HaproxyConfigError(
      msg(
        'Die Admin-IPs lassen sich nicht leeren, solange {count} Eintrag/Einträge darauf gesperrt sind: {names}. Erst dort die Sperre lösen.',
        { count: current.lockedServices.length, names: current.lockedServices.join(', ') }
      )
    );
  }

  let lines = text.split('\n');

  /* ── Die Admin-ACL ──
   *
   * Sie muss VOR ihrer ersten Verwendung stehen, sonst lehnt HAProxy die Datei
   * mit „unknown acl" ab. Der Anker ist deshalb die letzte `bind`-Zeile des
   * Frontends, in dem die Dienste stehen — der einzige Ort, von dem sicher ist,
   * dass er vor allen Dienst-Blöcken liegt. */
  const existing = adminAclLines(lines);
  const aclLine = `acl ${ADMIN_ACL} src ${input.adminIps.join(' ')}`;
  if (existing.length === 1) {
    const indent = /^\s*/.exec(lines[existing[0].index])?.[0] ?? '    ';
    if (input.adminIps.length === 0) {
      // Ohne Adressen gibt es die ACL nicht: `acl admin_ips src` ohne Argument
      // ist ein Syntaxfehler. Der Marker darüber geht mit.
      const marker = clean(lines[existing[0].index - 1] ?? '') === ADMIN_MARKER ? 1 : 0;
      lines.splice(existing[0].index - marker, 1 + marker);
    } else {
      lines[existing[0].index] = `${indent}${aclLine}`;
    }
  } else if (input.adminIps.length > 0) {
    const anchor = adminAnchor(lines);
    if (anchor === null) {
      throw new HaproxyConfigError(
        msg(
          'In {file} war keine Stelle zu finden, an die "acl {acl}" gehört: gesucht wird die letzte bind-Zeile des Frontends, in dem die Dienste stehen.',
          { file: HAPROXY_CFG, acl: ADMIN_ACL }
        )
      );
    }
    const indent = /^\s*/.exec(lines[anchor])?.[0] ?? '    ';
    lines.splice(anchor + 1, 0, '', `${indent}${ADMIN_MARKER}`, `${indent}${aclLine}`);
  }

  /* ── Der Zugriffsschutz ──
   *
   * Immer neu geschrieben, auch wenn das Feld fehlt: die Ausnahme für die
   * Admin-IPs (`!admin_ips`) gibt es nur, solange die ACL existiert. Ein von
   * Hand geänderter Block bleibt stehen, solange niemand ihn ändern will. */
  if (current.protection === null) {
    if (input.protection) {
      throw new HaproxyConfigError(
        msg(
          'Der Block "{marker}" in {file} steht nicht so da, wie HAPM ihn schreibt. Er wird deshalb nicht überschrieben. Erst in der Datei auf den Stand von HAPM bringen oder entfernen.',
          { marker: PROTECTION_MARKER, file: HAPROXY_CFG }
        )
      );
    }
  } else {
    lines = applyProtectionBlock(lines, input.protection ?? current.protection, input.adminIps.length > 0);
  }

  if (input.crowdsec !== undefined && input.crowdsec !== current.crowdsec) {
    if (current.crowdsec === null) {
      throw new HaproxyConfigError(
        msg(
          'Der Block "{marker}" in {file} steht nicht so da, wie HAPM ihn schreibt. Er wird deshalb nicht überschrieben. Erst in der Datei auf den Stand von HAPM bringen oder entfernen.',
          { marker: CROWDSEC_MARKER, file: HAPROXY_CFG }
        )
      );
    }
    lines = applyCrowdsecBlock(lines, input.crowdsec);
  }

  const block = httpsBlockRange(lines)!;
  const indent = /^\s*/.exec(lines[block.start])?.[0] ?? '    ';
  // Eingerückt wird wie die Marker-Zeile: HAProxy ist die Einrückung egal, dem
  // Menschen, der die Datei danach von Hand aufmacht, nicht.
  const body = input.httpsLines.map((line) => `${indent}${line}`);
  lines = [...lines.slice(0, block.start + 1), ...body, ...lines.slice(block.end)];

  return lines.join('\n');
}

/**
 * Der Fehler, den eine Textänderung werfen kann. Trägt eine Meldung für den Benutzer.
 *
 * Ist selbst eine `Message` (`text`, `params`): die Route reicht ihn als
 * `new ApiError(err, 409)` weiter und übersetzt ihn dort. `message` bleibt der
 * deutsche Text samt Werten. Nicht von `ApiError` abgeleitet, weil diese Datei
 * auch im Browser läuft und `lib/api.ts` an `next/server` hängt.
 */
export class HaproxyConfigError extends Error implements Message {
  readonly text: string;
  readonly params?: Params;

  constructor(message: string | Message) {
    const text = typeof message === 'string' ? message : message.text;
    const params = typeof message === 'string' ? undefined : message.params;
    super(interpolate(text, params));
    this.name = 'HaproxyConfigError';
    this.text = text;
    this.params = params;
  }
}

/** Vor den END-Marker eines Bereichs einsetzen. Gesucht wird über dieselbe
 *  Erkennung wie beim Lesen: die Marker-Zeile auf der Maschine muss nicht auf
 *  das Zeichen dem entsprechen, was dieses Modul schreiben würde. */
export function insertBeforeScopeMarker(
  lines: string[],
  scope: string,
  kind: ScopeKind,
  block: string[]
): string[] {
  const marker = scopeMarkers(lines).find(
    (m) => m.edge === 'end' && m.kind === kind && m.name.toUpperCase() === scope.toUpperCase()
  );
  if (!marker) {
    throw new HaproxyConfigError(
      msg('In {file} fehlt der Marker "{marker}". Ohne ihn ist nicht bestimmbar, wo der Eintrag hingehört.', {
        file: HAPROXY_CFG,
        marker: scopeMarkerLine(scope, 'END', kind),
      })
    );
  }
  return [...lines.slice(0, marker.index), ...block, ...lines.slice(marker.index)];
}

/* ── Die Reihenfolge im SERVICES-Teil ──
 *
 * HAProxy nimmt die ERSTE passende Weiche. Solange jeder Eintrag exakte Domains
 * trägt, schließen sich die ACLs gegenseitig aus und die Reihenfolge trägt
 * keine Bedeutung — ein neuer Block könnte schlicht vor dem END-Marker landen.
 *
 * Mit Wildcards ist das nicht mehr wahr. Ein Eintrag `*.kunde.example`, danach
 * angelegt `app.kunde.example`: der neue Block stünde darunter, seine Weiche käme
 * nie zum Zug, und `haproxy -c` sieht daran nichts Falsches — dieselbe Falle
 * wie bei den Weichen der Pfad-Regeln, nur zwischen Diensten statt innerhalb
 * eines.
 *
 * Der SERVICES-Teil hat deshalb eine Invariante: exakte Blöcke zuerst, danach
 * die Wildcards, unter den Wildcards das ENGERE Muster vor dem weiteren. Sie
 * wird beim Einfügen hergestellt und nicht nachträglich repariert — eine
 * vorgefundene Datei umzusortieren wäre eine Verhaltensänderung, die niemand
 * angefordert hat (siehe `shadowedBy`).
 */

/**
 * Wie weit ein Eintrag greift: die Länge des kürzesten Wildcard-Suffixes, denn
 * das kürzeste trifft am meisten. `null` heißt: keine Wildcard, der Eintrag
 * trifft nur seine eigenen Domains.
 */
function reachOf(domains: string[]): number | null {
  const lengths = domains.filter(isWildcardDomain).map((d) => wildcardSuffix(d).length);
  return lengths.length === 0 ? null : Math.min(...lengths);
}

/** Negativ, wenn `a` vor `b` stehen muss. Zwei exakte Einträge sind gleich —
 *  ihre Reihenfolge untereinander trägt weiterhin keine Bedeutung. */
export function compareServiceOrder(a: string[], b: string[]): number {
  const reachA = reachOf(a);
  const reachB = reachOf(b);
  if (reachA === null && reachB === null) return 0;
  if (reachA === null) return -1;
  if (reachB === null) return 1;
  // Längeres Suffix heißt engeres Muster: `.a.kunde.example` vor `.kunde.example`.
  return reachB - reachA;
}

/**
 * Den Dienst-Block an die Stelle setzen, an der die Invariante hält: vor den
 * ersten Block, den er schlagen muss, sonst vor den END-Marker.
 */
function insertServiceBlock(
  lines: string[],
  scope: string,
  block: string[],
  domains: string[],
  services: HaproxyService[]
): string[] {
  const marker = scopeMarkers(lines).find(
    (m) => m.edge === 'end' && m.kind === 'services' && m.name.toUpperCase() === scope.toUpperCase()
  );
  if (!marker) {
    throw new HaproxyConfigError(
      msg('In {file} fehlt der Marker "{marker}". Ohne ihn ist nicht bestimmbar, wo der Eintrag hingehört.', {
        file: HAPROXY_CFG,
        marker: scopeMarkerLine(scope, 'END', 'services'),
      })
    );
  }

  const resolve = scopeResolver(lines, 'services');
  const byId = new Map(services.map((service) => [service.id, service]));

  let insertAt = marker.index;
  for (let index = 0; index < marker.index; index++) {
    const auto = /^#\s*AUTO:\s*(\S+)$/.exec(clean(lines[index]));
    if (!auto) continue;
    // Nur die Kommentare im SERVICES-Teil DIESER Gruppe. Die Backend-Blöcke
    // tragen denselben Kommentar und liegen hinter allen Marken dieser Art,
    // der Resolver gibt für sie `null`.
    if (resolve(index) !== scope) continue;
    const service = byId.get(auto[1]);
    if (!service) continue;
    if (compareServiceOrder(domains, service.domains) >= 0) continue;

    // Vor die Leerzeile, mit der der gefundene Block anfängt — sonst stünden
    // zwei Leerzeilen vor dem neuen Eintrag und gar keine vor dem alten.
    insertAt = index;
    while (insertAt > 0 && clean(lines[insertAt - 1]) === '') insertAt--;
    break;
  }

  return [...lines.slice(0, insertAt), ...block, ...lines.slice(insertAt)];
}

/* ── Bereiche anlegen und entfernen ──
 *
 * Eine Gruppe der Oberfläche ist ein Marker-Paar in der Datei, sonst nichts.
 * Es gibt keine Collection dahinter und keine Beschriftung, die irgendwo
 * gespeichert wäre — was es gibt, sagt die Konfiguration.
 *
 * Angelegt wird hinter dem LETZTEN Marker seiner Art: der SERVICES-Block muss
 * im Frontend bleiben, der BACKENDS-Block außerhalb. Geraten wird dabei nichts.
 * Gibt es keinen einzigen Marker, an den sich anschließen ließe, ist das eine
 * Meldung und keine Vermutung darüber, wo im Frontend ein Block hingehört —
 * dieselbe Regel wie beim HTTPS-Marker.
 */

const SCOPE_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
const SCOPE_NAME_MAX = 24;

export function validateScopeName(name: string): Message | null {
  const value = name.trim();
  if (value.length < 2) return msg('Der Name der Gruppe braucht mindestens zwei Zeichen.');
  if (value.length > SCOPE_NAME_MAX) {
    return msg('Der Name der Gruppe ist auf {max} Zeichen begrenzt.', { max: SCOPE_NAME_MAX });
  }
  if (!SCOPE_NAME.test(value)) {
    return msg('Der Name darf nur a-z, 0-9, _ und - enthalten und muss mit einem Buchstaben beginnen.');
  }
  if (RESERVED_SCOPE_SLUGS.includes(scopeSlug(value))) {
    return msg('„{name}“ ist der Name einer Seite unter Reverse-Proxy. Bitte einen anderen Namen wählen.', {
      name: value,
    });
  }
  return null;
}

/**
 * Die festen Seiten unter `/reverse-proxy/`. Eine Gruppe steht unter
 * `/reverse-proxy/<slug>`, und eine mit einem dieser Namen wäre hinter der
 * Seite verborgen: Next nimmt den festen Pfad vor `[scope]`. Eine vorhandene
 * Gruppe dieses Namens bleibt lesbar, nur neu anlegen lässt sie sich nicht.
 */
export const RESERVED_SCOPE_SLUGS: readonly string[] = [
  'api',
  'einstellungen',
  'fehlerseiten',
  'import',
  'logs',
  'statistiken',
  'zertifikate',
];

/**
 * Wohin die ERSTE Gruppe gehört, solange es keine gibt.
 *
 * Das ist der Zustand einer frischen Installation (die Grundkonfiguration
 * bringt keine Gruppe mit) und der nach dem Entfernen der letzten: in der
 * Datei steht kein Marker, an den sich eine neue anschließen ließe. Der Marker
 * der globalen Einstellungen sagt, in welchem Frontend die Dienste liegen. Das
 * ist abgelesen und nicht geraten. Fehlt auch er, gibt es keine Stelle, und
 * der Aufrufer bekommt eine Meldung.
 *
 * Der SERVICES-Teil kommt vor `default_backend` dieses Frontends samt dem
 * Kommentar direkt darüber (die Zeile gilt für alles, was keine Weiche davor
 * trifft), sonst an sein Ende. Der BACKENDS-Teil kommt hinter das Frontend,
 * vor den nächsten Abschnitt samt seiner Überschrift aus Kommentarzeilen.
 */
function firstScopeAnchor(lines: string[], kind: ScopeKind): number | null {
  const marker = lines.findIndex((line) => clean(line) === HTTPS_MARKER);
  if (marker === -1) return null;

  let end = marker + 1;
  while (end < lines.length && !SECTION_KEYWORDS.test(clean(lines[end]))) end++;

  const isComment = (line: string) => line.startsWith('#') && !SCOPE_MARKER.test(line);

  if (kind === 'services') {
    for (let i = marker + 1; i < end; i++) {
      if (!/^default_backend\s/.test(clean(lines[i]))) continue;
      let at = i;
      while (at > marker + 1 && isComment(clean(lines[at - 1]))) at--;
      return at;
    }
  }

  // Zurück über die Überschrift des nächsten Abschnitts. Zwischen ihr und dem
  // Abschnitt darf eine Leerzeile stehen. Ein Marker gehört nie dazu: der
  // SERVICES-Teil derselben Gruppe kann gerade erst am Ende des Frontends
  // gelandet sein.
  let at = end;
  for (let i = end - 1; i > marker; i--) {
    const line = clean(lines[i]);
    if (line === '') continue;
    if (!isComment(line)) break;
    at = i;
  }
  return at;
}

function appendScopeBlock(lines: string[], name: string, kind: ScopeKind): string[] {
  const last = scopeMarkers(lines)
    .filter((marker) => marker.edge === 'end' && marker.kind === kind)
    .pop();
  if (!last) {
    const at = firstScopeAnchor(lines, kind);
    if (at === null) {
      throw new HaproxyConfigError(
        msg(
          'In {file} steht kein einziger Marker "# END AUTO … {kind}" und auch nicht die Zeile "{marker}". Ohne eines von beiden ist nicht bestimmbar, an welche Stelle der Datei eine neue Gruppe gehört.',
          { file: HAPROXY_CFG, kind: kind === 'services' ? 'SERVICES' : 'BACKENDS', marker: HTTPS_MARKER }
        )
      );
    }
    // Der SERVICES-Teil steht im Frontend und ist eingerückt wie dessen Zeilen.
    const indent =
      kind === 'services'
        ? (/^\s*/.exec(lines.find((line) => clean(line) === HTTPS_MARKER) ?? '')?.[0] ?? '')
        : '';
    return [
      ...lines.slice(0, at),
      `${indent}${scopeMarkerLine(name, 'BEGIN', kind)}`,
      `${indent}${scopeMarkerLine(name, 'END', kind)}`,
      '',
      ...lines.slice(at),
    ];
  }
  const indent = /^\s*/.exec(lines[last.index])?.[0] ?? '';
  return [
    ...lines.slice(0, last.index + 1),
    '',
    `${indent}${scopeMarkerLine(name, 'BEGIN', kind)}`,
    `${indent}${scopeMarkerLine(name, 'END', kind)}`,
    ...lines.slice(last.index + 1),
  ];
}

export function addScope(text: string, name: string): string {
  const invalid = validateScopeName(name);
  if (invalid) throw new HaproxyConfigError(invalid);

  const scopes = parseScopes(text);
  if (findScope(scopes, name)) {
    throw new HaproxyConfigError(
      msg('Es gibt in {file} bereits eine Gruppe "{name}".', { file: HAPROXY_CFG, name })
    );
  }

  let lines = text.split('\n');
  lines = appendScopeBlock(lines, name, 'services');
  lines = appendScopeBlock(lines, name, 'backends');
  return lines.join('\n');
}

/**
 * Eine Gruppe entfernen: die Marker-Paare beider Teile.
 *
 * `alsoOccupiedBy` sind die Kennungen, die in dieser Gruppe stehen und die
 * diese Datei nicht selbst lesen kann — die TCP-Weiterleitungen aus
 * `streams.ts`. Sie kommen als Parameter herein und nicht über einen Import,
 * weil `streams.ts` seinerseits aus dieser Datei liest; ein Kreis daraus wäre
 * das Gegenteil dessen, was die Trennung erreichen soll. Der Aufrufer, der
 * beides gelesen hat, ist `provision.ts`.
 */
export function removeScope(text: string, name: string, alsoOccupiedBy: string[] = []): string {
  const scopes = parseScopes(text);
  const scope = findScope(scopes, name);
  if (!scope) {
    throw new HaproxyConfigError(msg('Die Gruppe "{name}" steht nicht in {file}.', { name, file: HAPROXY_CFG }));
  }

  const occupants = [
    ...parseHaproxyConfig(text)
      .filter((service) => service.scope?.toUpperCase() === scope.name.toUpperCase())
      .map((service) => service.id),
    ...alsoOccupiedBy,
  ];
  if (occupants.length > 0) {
    throw new HaproxyConfigError(
      msg('In der Gruppe "{name}" stehen noch {count} Einträge: {entries}. Erst dort aufräumen.', {
        name: scope.label,
        count: occupants.length,
        entries: occupants.join(', '),
      })
    );
  }
  if (!scope.removable) {
    throw new HaproxyConfigError(
      msg(
        'Die Gruppe "{name}" lässt sich hier nicht entfernen. Dafür müssen BEGIN- und END-Marker beider Teile dastehen und nichts als Leerzeilen dazwischen — sonst ist nicht bestimmbar, was zu ihr gehört und was zum Block darüber.',
        { name: scope.label }
      )
    );
  }

  let lines = text.split('\n');
  for (const kind of ['services', 'backends'] as ScopeKind[]) {
    const own = scopeMarkers(lines).filter(
      (marker) => marker.kind === kind && marker.name.toUpperCase() === scope.name.toUpperCase()
    );
    const begin = own.find((marker) => marker.edge === 'begin')!;
    const end = own.find((marker) => marker.edge === 'end')!;
    // Eine Leerzeile davor gehörte zur Trennung und hat ohne den Block nichts
    // mehr zu trennen: sonst bleibt bei jedem Anlegen und Entfernen eine übrig.
    const from = clean(lines[begin.index - 1] ?? 'x') === '' ? begin.index - 1 : begin.index;
    lines = [...lines.slice(0, from), ...lines.slice(end.index + 1)];
  }
  return lines.join('\n');
}

/**
 * Warum sich unter dieser ID kein Eintrag anlegen lässt, oder `null`.
 *
 * Eine Funktion für zwei Aufrufer: `addService` lehnt damit ab, und
 * `assignServiceId` sucht damit die erste freie ID. Zwei Fassungen derselben
 * Frage wären eine vergebene ID, die erst `haproxy -c` bemerkt.
 */
function serviceNameConflict(
  lines: string[],
  id: string,
  routes: readonly { name: string }[]
): Message | null {
  const hasAcl = (name: string) =>
    lines.some((line) => new RegExp(`^\\s*acl\\s+${escapeRegExp(name)}\\s`).test(line));

  for (const acl of [aclNameFor(id), lockAclFor(id), passAclFor(id)]) {
    if (hasAcl(acl)) return msg('Die ACL "{acl}" gibt es bereits. Die Dienst-ID ist vergeben.', { acl });
  }
  /* Ein Abschnittsname gilt in HAProxy über `frontend`, `backend` und `listen`
   * hinweg. Nur gegen `backend` zu prüfen ließ einen Dienst entstehen, der so
   * heißt wie eine TCP-Weiterleitung daneben — und die Datei wird als Ganzes
   * abgelehnt, also fällt es erst im `haproxy -c` des Vorgangs auf. */
  const section = lines.find((line) =>
    new RegExp(`^\\s*(frontend|backend|listen)\\s+${escapeRegExp(id)}\\s*$`).test(clean(line))
  );
  if (section) {
    return msg('Der Name "{id}" ist in der Konfiguration bereits vergeben ({line}). Die Dienst-ID ist belegt.', {
      id,
      line: clean(section),
    });
  }

  // Dieselbe Prüfung für jede Pfad-Regel. Ihre Namen sind abgeleitet, aber
  // trotzdem echte Namen im selben Namensraum: „coolify" mit einer Regel
  // „terminal" belegt `coolify_terminal`, und das kann ein eigener Dienst sein,
  // den jemand vorher angelegt hat.
  for (const route of routes) {
    const routeAcl = routeAclFor(id, route.name);
    const routeBackend = routeBackendFor(id, route.name);
    if (hasAcl(routeAcl)) {
      return msg('Die ACL "{acl}" gibt es bereits. Der Name der Pfad-Regel „{route}" ist vergeben.', {
        acl: routeAcl,
        route: route.name,
      });
    }
    if (lines.some((line) => new RegExp(`^\\s*backend\\s+${escapeRegExp(routeBackend)}\\s*$`).test(line))) {
      return msg('Das Backend "{backend}" gibt es bereits. Der Name der Pfad-Regel „{route}" ist vergeben.', {
        backend: routeBackend,
        route: route.name,
      });
    }
  }
  return null;
}

/**
 * Die ID für einen neuen Eintrag: aus seiner Hauptdomain (`serviceIdFor`), und
 * zwar die erste Fassung, die in DIESER Konfiguration frei ist.
 *
 * `reserved` sind IDs, die schon vergeben, aber noch nicht geschrieben sind:
 * zwischen der Vorabprüfung und dem Schreiben liegt die Zertifikatsausstellung,
 * und ein zweiter Dialog läse in der Zeit dieselbe Datei. Die Liste führt
 * `provision.ts`, hier kommt sie nur herein.
 */
export function assignServiceId(
  text: string,
  input: Pick<CreateServiceInput, 'domains' | 'routes'>,
  reserved: Iterable<string> = []
): string {
  const lines = text.split('\n');
  const held = new Set(reserved);
  return firstFreeId(
    serviceIdBase(input.domains[0] ?? ''),
    (id) => held.has(id) || serviceNameConflict(lines, id, input.routes) !== null
  );
}

/**
 * Einen Dienst in die Konfiguration einsetzen.
 *
 * Prüft vorher, was HAProxy erst beim Laden bemerken würde: ein doppelter
 * Backend-Name, eine doppelte ACL, eine Domain, die schon woanders geroutet
 * wird. Das Letzte ist der teure Fall — HAProxy nimmt zwei ACLs mit derselben
 * Domain klaglos an und schickt den Verkehr an die erste. Eine fremde Seite
 * verschwindet dann, ohne dass irgendwo ein Fehler steht.
 */
export function addService(text: string, input: CreateServiceInput): string {
  const invalid = validateCreateInput(input);
  if (invalid) throw new HaproxyConfigError(invalid);

  const services = parseHaproxyConfig(text);
  let lines = text.split('\n');

  const taken = serviceNameConflict(lines, input.id, input.routes);
  if (taken) throw new HaproxyConfigError(taken);

  const conflict = findDomainConflict(services, input.domains);
  if (conflict) {
    throw new HaproxyConfigError(
      msg('Die Domain {domain} wird bereits von "{id}" bedient.', {
        domain: conflict.domain,
        id: conflict.service.id,
      })
    );
  }

  // Sperren ohne Adressen wäre eine Regel auf eine ACL, die es nicht gibt:
  // HAProxy lehnt die ganze Datei ab, und der Vorgang scheiterte erst beim
  // `haproxy -c` — mit einer Meldung, die nicht sagt, woran es liegt.
  // Nur für die Sperre auf Admin-IPs: eine Passwortsperre benutzt die Liste
  // nicht. Bei ihr wird hier dafür geprüft, dass ein Passwort da ist.
  const password = passwordLockOf(input);
  if (
    input.lockedDomains.length > 0 &&
    password === null &&
    parseGlobalSettings(text).adminIps.length === 0
  ) {
    throw new HaproxyConfigError(
      msg(
        'Es sind keine Admin-IPs gesetzt. Ohne mindestens eine Adresse lässt sich kein Eintrag sperren — die Liste steht unter Reverse-Proxy → Einstellungen.'
      )
    );
  }

  // Ob es die Gruppe gibt, weiß nur die Konfiguration. Ein unvollständiger
  // Bereich (nur einer der beiden Marker) ist kein Ziel: der Dienst-Block landete
  // dann irgendwo, und „irgendwo" heißt beim Reverse-Proxy in einem fremden Block.
  const scope = findScope(parseScopes(text), input.scope);
  if (!scope || !scope.complete) {
    throw new HaproxyConfigError(
      msg(
        'In {file} gibt es keine vollständige Gruppe "{name}". Erwartet werden "{services}" und "{backends}", jeweils genau einmal.',
        {
          file: HAPROXY_CFG,
          name: input.scope,
          services: scopeMarkerLine(input.scope, 'END', 'services'),
          backends: scopeMarkerLine(input.scope, 'END', 'backends'),
        }
      )
    );
  }

  lines = insertServiceBlock(
    lines,
    scope.name,
    renderServiceBlock(input),
    input.domains,
    services
  );
  lines = insertBeforeScopeMarker(lines, scope.name, 'backends', renderBackendBlock(input));
  return lines.join('\n');
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Einen Dienst aus der Konfiguration nehmen: Kommentar, ACL, Weiche und der
 * ganze Backend-Block.
 *
 * Der Backend-Block hat kein Ende, nur einen Anfang — HAProxy beendet einen
 * Abschnitt erst dadurch, dass der nächste beginnt. Übersprungen wird deshalb
 * bis zum nächsten Abschnittswort, zum nächsten `# AUTO:`, zu einem
 * AUTO-Marker oder zu einer Trennlinie aus Gleichheitszeichen. Ohne die letzten
 * beiden Fälle risse das Löschen den Marker mit heraus, hinter dem der nächste
 * Eintrag eingefügt wird.
 */
export function removeService(text: string, id: string): string {
  /**
   * Was mitgeht, wird GELESEN und nicht aus dem Namen geraten.
   *
   * Die Pfad-Regeln heißen `<id>_<name>`, und ein Namenspräfix als Regel wäre
   * genau der Fehler, den diese Datei sonst überall vermeidet: ein Dienst
   * „coolify" nähme beim Löschen einen eigenständigen Dienst „coolify_ui" mit,
   * den jemand daneben angelegt hat. Der Parser weiß dagegen, welche Weiche zu
   * welcher Host-ACL gehört.
   */
  const service = parseHaproxyConfig(text).find((s) => s.id === id);
  const ownBackends = new Set([id, ...(service?.routes.map((r) => r.backend) ?? [])]);
  // `lock_<id>` steht immer mit drin, auch wenn dieser Eintrag gerade keine
  // Teil-Sperre hat: sie ist der Rest eines früheren Standes, und liegen
  // bleiben darf sie nicht — eine ACL ohne Regel ist harmlos, eine Regel ohne
  // ACL lässt HAProxy die Datei ablehnen.
  const ownAcls = new Set([
    aclNameFor(id),
    lockAclFor(id),
    // Die Cookie-ACL der Passwortsperre, aus demselben Grund immer.
    passAclFor(id),
    ...(service?.routes.map((r) => r.aclName) ?? []),
  ]);

  const lines = text.split('\n');
  const out: string[] = [];

  let skippingBackend = false;
  let touched = false;
  let lastWasSkipped = false;

  /**
   * Die Leerzeile vor einem entfernten Block geht mit.
   *
   * Eingefügt wird immer mit einer Leerzeile davor. Bliebe sie stehen, wüchse
   * die Datei bei jedem Anlegen-und-Löschen um eine weitere leere Zeile — nach
   * einem Jahr Betrieb ist das der Grund, aus dem niemand mehr von Hand
   * hineinschaut. Der Test „anlegen und wieder entfernen ergibt den Anfang"
   * hält genau das fest.
   */
  const skip = () => {
    if (!lastWasSkipped && out.length > 0 && clean(out[out.length - 1]) === '') out.pop();
    lastWasSkipped = true;
    touched = true;
  };

  for (const raw of lines) {
    const line = clean(raw);

    if (skippingBackend) {
      const ends =
        SECTION_KEYWORDS.test(line) ||
        /^#\s*AUTO:/.test(line) ||
        /^#\s*(BEGIN|END)\s+AUTO/.test(line) ||
        /^#\s*=+/.test(line);
      if (!ends) {
        skip();
        continue;
      }
      skippingBackend = false;
    }

    if (line === `# AUTO: ${id}`) {
      skip();
      continue;
    }

    const aclLine = /^acl\s+(\S+)(\s|$)/.exec(line);
    if (aclLine && ownAcls.has(aclLine[1])) {
      skip();
      continue;
    }

    const useLine = /^use_backend\s+(\S+)(\s|$)/.exec(line);
    if (useLine && ownBackends.has(useLine[1])) {
      skip();
      continue;
    }

    /* Regeln, die auf eine eigene ACL zeigen — die Sperre auf Admin-IPs und
     * alles, was jemand von Hand danebengeschrieben hat. Sie MÜSSEN mitgehen:
     * die ACL geht mit, und eine Regel auf eine ACL, die es nicht mehr gibt,
     * lässt HAProxy beim nächsten Start mit „unknown acl" stehen. */
    const ruleLine = /^http-(?:request|response)\s+.*?\sif\s+(.+)$/.exec(line);
    if (ruleLine) {
      const conditions = ruleLine[1].trim().split(/\s+/);
      if (conditions.some((c) => ownAcls.has(c.replace(/^!/, '')))) {
        skip();
        continue;
      }
    }

    const backendLine = /^backend\s+(\S+)\s*$/.exec(line);
    if (backendLine && ownBackends.has(backendLine[1])) {
      skip();
      skippingBackend = true;
      continue;
    }

    out.push(raw);
    lastWasSkipped = false;
  }

  if (!touched) {
    throw new HaproxyConfigError(msg('Der Dienst "{id}" steht nicht in {file}.', { id, file: HAPROXY_CFG }));
  }

  return out.join('\n');
}

/**
 * Einen Dienst ersetzen: entfernen und neu einsetzen, in einem Text.
 *
 * Entfernen ZUERST, und zwar nicht aus Bequemlichkeit: erst danach sind ID,
 * ACL-Name und Domains wieder frei, und `addService` kann seine Prüfungen
 * unverändert durchlaufen. Ohne das meldete jede Änderung, die den Namen
 * behält, einen Konflikt mit sich selbst.
 *
 * Der Block landet dabei an der Stelle, die seine Domains ihm zuweisen, und
 * nicht an seiner alten. Das ist der Preis dafür, dass es nur einen Schreibweg
 * gibt — und er ist keiner: unter exakten Einträgen trägt die Reihenfolge keine
 * Bedeutung (die ACLs schließen einander aus), und wo sie eine trägt, stellt
 * `insertServiceBlock` sie her. Eine Änderung, die aus `app.kunde.example` ein
 * `*.kunde.example` macht, wandert damit von selbst ans richtige Ende.
 */
export function replaceService(
  text: string,
  oldId: string,
  input: CreateServiceInput
): string {
  /* Das Passwort, das schon dasteht, wird HIER eingesetzt: nur an dieser Stelle
   * liegen der alte Eintrag und die neue Eingabe nebeneinander. Gelesen wird es
   * aus demselben Text, in den gleich geschrieben wird, also innerhalb des
   * Locks und nicht aus einer Momentaufnahme von vorhin. */
  let next = input;
  if (input.passwordLock === KEEP_PASSWORD || input.passwordLock === INHERIT_LOCK) {
    const found = parseHaproxyConfig(text).find((s) => s.id === oldId)?.passwordLock ?? null;
    const current = found !== null && typeof found === 'object' ? found : null;
    if (current === null && input.passwordLock === KEEP_PASSWORD) {
      throw new HaproxyConfigError(
        msg('Für "{id}" ist noch kein Passwort gesetzt. Eine Passwortsperre braucht eins.', { id: oldId })
      );
    }
    next = { ...input, passwordLock: current };
  }
  return addService(removeService(text, oldId), next);
}

/**
 * Einen gelesenen Dienst zurück in die Form bringen, aus der er entstanden ist —
 * damit das Formular ihn vorbelegen kann.
 *
 * Nur für `editable`-Einträge sinnvoll; bei allen anderen wäre das Ergebnis eine
 * Behauptung darüber, was in der Datei steht. Deshalb wirft es statt zu raten.
 */
export function toCreateInput(service: HaproxyService): CreateServiceInput {
  if (!service.editable || !service.scope) {
    throw new HaproxyConfigError(
      msg(
        '"{id}" lässt sich nicht bearbeiten: der Eintrag enthält Einstellungen, die dieses Formular nicht abbildet.',
        { id: service.id }
      )
    );
  }
  return {
    scope: service.scope,
    id: service.id,
    domains: [...service.domains],
    servers: service.servers.map((s) => ({ name: s.name, target: s.target, weight: s.weight })),
    redirect: service.redirect ? { ...service.redirect } : null,
    routes: service.routes.map((route) => ({
      name: route.name,
      paths: [...route.paths],
      servers: route.servers.map((s) => ({ name: s.name, target: s.target })),
      check: route.check,
      backendTls: route.backendTls,
    })),
    balance: service.balance,
    sticky: service.sticky,
    lockedDomains: [...service.lockedDomains],
    passwordLock:
      service.passwordLock !== null && typeof service.passwordLock === 'object'
        ? { ...service.passwordLock }
        : service.passwordLock,
    responseHeaders: service.responseHeaders.map((rule) => ({ ...rule })),
    requestHeaders: service.requestHeaders.map((rule) => ({ ...rule })),
    tunnel: service.tunnel,
    crowdsec: service.crowdsec,
    healthcheck: service.healthcheck,
    backendTls: service.backendTls,
  };
}

/**
 * Ob für diese Änderung ein neues Zertifikat nötig ist.
 *
 * Die Reihenfolge zählt mit, nicht nur die Menge: die erste Domain ist die
 * Hauptdomain, und nach ihr heißt die PEM-Datei. Wer sie tauscht, braucht ein
 * Zertifikat unter dem neuen Namen, auch wenn dieselben Domains darin stehen.
 */
export function certificateChanged(before: string[], after: string[]): boolean {
  const norm = (list: string[]) => list.map((d) => d.toLowerCase()).join(' ');
  return norm(before) !== norm(after);
}

/**
 * Ein Ziel so kurz, wie es eindeutig bleibt: nur `:6002`, solange es auf
 * derselben Maschine liegt wie das Ziel daneben.
 *
 * Auf einer Karte stehen bei Coolify vier Adressen untereinander, die sich in
 * einer Ziffer unterscheiden — die Wiederholung der Adresse macht die
 * Unterschiede unsichtbar. Zeigt eine Regel dagegen auf eine ANDERE Maschine,
 * steht sie voll da: die Abkürzung behauptete sonst eine Maschine, die es nicht
 * ist. Rein, weil die Bedingung genau das ist, was man beim Hinschreiben
 * übersieht.
 */
export function shortTarget(target: string, base: string | undefined): string {
  const cut = target.lastIndexOf(':');
  if (cut === -1 || !base) return target;
  const baseCut = base.lastIndexOf(':');
  if (baseCut === -1) return target;
  return target.slice(0, cut) === base.slice(0, baseCut) ? target.slice(cut) : target;
}

/** Passt ein Dienst zur Suche? Domain, ID und Backend-Ziel — alles, was auf der
 *  Karte steht und wonach man sucht. */
export function matchesSearch(service: HaproxyService, term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return true;
  const hitsServers = (servers: HaproxyBackendServer[]) =>
    servers.some(
      (s) => s.target.toLowerCase().includes(needle) || s.name.toLowerCase().includes(needle)
    );
  return (
    service.id.toLowerCase().includes(needle) ||
    service.domains.some((d) => d.toLowerCase().includes(needle)) ||
    hitsServers(service.servers) ||
    // Bei einer Weiterleitung steht das Ziel an der Stelle, an der sonst die
    // Backend-Adresse steht — und danach sucht man genauso.
    (service.redirect?.to.toLowerCase().includes(needle) ?? false) ||
    // Die Ziele einer Pfad-Regel sind eigene Adressen und eigene Ports. Wer
    // nach „6001" sucht, sucht genau danach.
    service.routes.some(
      (route) =>
        route.name.toLowerCase().includes(needle) ||
        route.paths.some((p) => p.toLowerCase().includes(needle)) ||
        hitsServers(route.servers)
    )
  );
}

/**
 * Einen Request-Rumpf in eine Eingabe umformen — normalisiert, aber nicht
 * geprüft. Das Prüfen bleibt bei `validateCreateInput`, damit es genau eine
 * Stelle gibt, die ja oder nein sagt.
 *
 * Hier und nicht in der Route, weil Anlegen und Bearbeiten dieselbe Umformung
 * brauchen. Zwei Kopien wären die Stelle, an der `healthcheck` beim Bearbeiten
 * plötzlich anders ausgewertet wird als beim Anlegen — und Next lässt aus einer
 * `route.ts` ohnehin nur Handler heraus.
 *
 * Domains werden kleingeschrieben, weil `hdr(host),lower` sie kleingeschrieben
 * vergleicht: „Kunde.example" in der ACL wäre eine Domain, die nie trifft.
 */
export function readServiceInput(body: unknown): CreateServiceInput {
  const raw = (body ?? {}) as Record<string, unknown>;

  const domains = Array.isArray(raw.domains)
    ? raw.domains.map((d) => String(d).trim().toLowerCase()).filter(Boolean)
    : [];

  const servers = readServers(raw.servers);

  const routes: RouteInput[] = Array.isArray(raw.routes)
    ? raw.routes.map((entry) => {
        const r = (entry ?? {}) as Record<string, unknown>;
        return {
          name: String(r.name ?? '').trim().toLowerCase(),
          paths: Array.isArray(r.paths)
            ? r.paths.map((p) => String(p).trim()).filter(Boolean)
            : [],
          // Ohne Gewichtung: eine Pfad-Regel verteilt nichts, sie trennt. Ein
          // mitgeschicktes `weight` fällt hier weg und nicht erst beim
          // Schreiben — siehe `RouteServerInput`.
          servers: readServers(r.servers).map((s) => ({ name: s.name, target: s.target })),
          check: r.check === true,
          backendTls: readBackendTlsInput(r.backendTls),
        };
      })
    : [];

  const scope = String(raw.scope ?? '').trim();

  /* Die Zusätze, und daneben `preset` für Aufrufer aus der Zeit davor. Ein
   * Preset war nie mehr als diese Zeilen, also wird es hier zu ihnen. Was der
   * Aufrufer ausdrücklich nennt, gewinnt: ein eigener `X-Robots-Tag` neben
   * `preset: "nextcloud"` bleibt der eigene. */
  const legacyPreset = String(raw.preset ?? '').trim();
  const responseHeaders = readHeaders(raw.responseHeaders);
  if (legacyPreset === 'nextcloud') {
    for (const rule of NEXTCLOUD_HEADERS) {
      if (!responseHeaders.some((own) => own.name.toLowerCase() === rule.name.toLowerCase())) {
        responseHeaders.push({ ...rule });
      }
    }
  }

  const lockedDomains = Array.isArray(raw.lockedDomains)
    ? raw.lockedDomains.map((d) => String(d).trim().toLowerCase()).filter(Boolean)
    : [];
  /* Die Passwortsperre kommt nie als Hash herein. Zwei Angaben führen zu ihr:
   * `passwordLock: "unchanged"` (das Passwort bleibt) und ein `lockPassword`
   * (ein neues, das die Route hasht, siehe `readServiceRequest`). Bis dahin
   * steht in beiden Fällen der Verweis hier. Ohne gesperrte Domain gibt es
   * nichts zu sperren, und dann steht hier auch nichts.
   *
   * Fehlt das Feld ganz, bleibt die Art der Sperre, wie sie ist
   * (`INHERIT_LOCK`). Ein ausdrückliches `null` heißt dagegen: auf Admin-IPs. */
  const wantsPassword =
    raw.passwordLock === KEEP_PASSWORD ||
    (typeof raw.lockPassword === 'string' && raw.lockPassword !== '');
  const lockUnsaid = raw.passwordLock === undefined && !wantsPassword;

  /* Ein fehlendes Feld heißt „keine balance-Zeile" und nicht „roundrobin": ein
   * Aufrufer, der davon nichts weiß, soll den `defaults`-Block der Maschine
   * gelten lassen. Ein UNBEKANNTER Wert wird dagegen durchgereicht und von
   * `validateCreateInput` abgelehnt — auf einen Vorgabewert gebogen wäre er
   * eine Entscheidung, die niemand getroffen hat. */
  const rawBalance = String(raw.balance ?? '').trim();
  const balance = rawBalance === '' ? null : (rawBalance as HaproxyBalance);

  /* Eine Weiterleitung ohne Ziel ist keine. Ein leeres Feld heißt deshalb „kein
   * Redirect" und nicht „Redirect nach nirgendwo" — sonst hinge an einem
   * Formular, das den Schalter kennt und das Feld leer lässt, eine Fehlermeldung
   * statt des Normalfalls. */
  const rawRedirect = (raw.redirect ?? null) as Record<string, unknown> | null;
  const redirectTo =
    rawRedirect && typeof rawRedirect === 'object' ? String(rawRedirect.to ?? '').trim() : '';
  const redirect: RedirectTarget | null = redirectTo
    ? {
        to: redirectTo,
        keepPath: rawRedirect!.keepPath === true,
        permanent: rawRedirect!.permanent === true,
      }
    : null;

  return {
    // Ein unbekannter Wert wird durchgereicht und von der Prüfung abgelehnt,
    // nicht auf einen Vorgabewert gebogen: die erste Gruppe der Liste, weil das
    // Feld leer ankam, wäre eine Entscheidung, die niemand getroffen hat.
    scope,
    id: String(raw.id ?? '').trim().toLowerCase(),
    domains,
    servers,
    redirect,
    routes,
    // Wie beim Healthcheck normalisiert und nicht abgelehnt: eine Weiterleitung
    // hat keine Ziele, auf die sich etwas verteilen ließe, und das Formular
    // blendet beide Felder dort ohnehin aus.
    balance: redirect ? null : balance,
    sticky: raw.sticky === true && !redirect,
    lockedDomains,
    passwordLock:
      lockedDomains.length === 0
        ? null
        : wantsPassword
          ? KEEP_PASSWORD
          : lockUnsaid
            ? INHERIT_LOCK
            : null,
    responseHeaders,
    requestHeaders: readHeaders(raw.requestHeaders),
    tunnel: raw.tunnel === true || legacyPreset === 'coolify',
    // Wie die übrigen Zusätze nur mit Zielen. Bei einer Weiterleitung
    // normalisiert statt abgelehnt: ihr Formular zeigt die Frage nicht.
    crowdsec: raw.crowdsec === true && !redirect,
    // Eine Wildcard als Hauptdomain schließt den Healthcheck aus, siehe
    // `healthcheckPossible`. Normalisiert und nicht abgelehnt: das Formular
    // sperrt den Schalter bereits, und die Route soll dieselbe Eingabe
    // annehmen statt sie für eine Frage zurückzuweisen, die sie selbst
    // beantworten kann. Dasselbe bei einer Weiterleitung: sie hat kein Ziel,
    // das sich prüfen ließe.
    healthcheck: raw.healthcheck === true && !redirect && healthcheckPossible(domains),
    // Wie `balance`: bei einer Weiterleitung gibt es keine Ziele, die etwas
    // sprechen könnten, und ihr Formular zeigt die Frage nicht.
    backendTls: redirect ? 'off' : readBackendTlsInput(raw.backendTls),
  };
}

/**
 * Die globalen Einstellungen aus einem Request-Rumpf — normalisiert, nicht
 * geprüft. Wie `readServiceInput`: das Prüfen bleibt bei
 * `validateGlobalSettings`, damit genau eine Stelle ja oder nein sagt.
 */
export function readGlobalSettingsInput(body: unknown): GlobalSettingsInput {
  const raw = (body ?? {}) as Record<string, unknown>;

  return {
    // Leere Zeilen fallen weg statt abgelehnt zu werden: das Formular hält eine
    // leere Zeile am Ende bereit, damit man tippen kann, ohne vorher auf
    // „hinzufügen" zu drücken.
    httpsLines: Array.isArray(raw.httpsLines)
      ? raw.httpsLines.map((line) => String(line).trim()).filter(Boolean)
      : [],
    adminIps: Array.isArray(raw.adminIps)
      ? raw.adminIps.map((ip) => String(ip).trim()).filter(Boolean)
      : [],
    protection: readProtectionInput(raw.protection),
    ...(typeof raw.crowdsec === 'boolean' ? { crowdsec: raw.crowdsec } : {}),
  };
}

/**
 * Dasselbe für einen Aufrufer, der nur EINE der beiden Listen meint —
 * `/api/internal/haproxy/settings`.
 *
 * Im Formular ist das Auslassen eines Feldes keine Frage: es schickt immer
 * beides, weil beides auf dem Bildschirm steht. Ein Dienst schickt dagegen die
 * eine Zeile, um die es ihm geht, und ein fehlendes `httpsLines` als „leer" zu
 * lesen hieße, dass ein Aufruf zum Eintragen einer Admin-Adresse nebenbei HSTS
 * von der Maschine nimmt. Deshalb: was nicht dasteht, bleibt stehen.
 *
 * `addAdminIps`/`removeAdminIps` gibt es, weil der übliche Aufruf „diese eine
 * Adresse dazu" ist. Über `adminIps` ginge das nur als Lesen-Ändern-Schreiben,
 * und zwischen den beiden Aufrufen liegt die Runde, in der jemand anders eine
 * Adresse einträgt, die der zweite Aufruf dann wieder mitnimmt.
 *
 * Beides zusammen wird abgelehnt statt aufgelöst: „setze die Liste auf A und
 * nimm B dazu" hat zwei vertretbare Ergebnisse, und welches gemeint war, weiß
 * nur der Aufrufer. Rein wie der Rest der Datei, damit
 * `tests/haproxy/settings.test.ts` es nachrechnen kann.
 */
export function readGlobalSettingsPatch(
  body: unknown,
  current: GlobalSettings
): GlobalSettingsInput | { error: Message } {
  const raw = (body ?? {}) as Record<string, unknown>;
  const list = (value: unknown): string[] | null =>
    Array.isArray(value) ? value.map((entry) => String(entry).trim()).filter(Boolean) : null;

  const replace = list(raw.adminIps);
  const added = list(raw.addAdminIps);
  const removed = list(raw.removeAdminIps);

  if (replace && (added || removed)) {
    return {
      error: msg(
        'adminIps setzt die ganze Liste, addAdminIps/removeAdminIps ändern sie. Beides in einem Aufruf lässt offen, was gemeint ist.'
      ),
    };
  }

  let adminIps = replace ?? current.adminIps;
  if (added || removed) {
    const drop = new Set(removed ?? []);
    // Die Reihenfolge bleibt: die Liste steht so in der Datei, und sie beim
    // Hinzufügen einer Adresse umzusortieren wäre eine Änderung im Diff, die
    // niemand angefordert hat.
    adminIps = [...adminIps.filter((ip) => !drop.has(ip)), ...(added ?? [])].filter(
      (ip, index, all) => all.indexOf(ip) === index
    );
  }

  // Der Zugriffsschutz feldweise wie der Rest: was fehlt, bleibt stehen.
  // `rateLimit: null` schaltet die Begrenzung ab, ein fehlendes Feld nicht.
  let protection: AccessProtection | undefined;
  const touchesProtection = ['blockedIps', 'blockedCountries', 'rateLimit'].some((key) => key in raw);
  if (touchesProtection) {
    const base = current.protection ?? EMPTY_PROTECTION;
    const read = readProtectionInput({
      blockedIps: 'blockedIps' in raw ? raw.blockedIps : base.blockedIps,
      blockedCountries: 'blockedCountries' in raw ? raw.blockedCountries : base.blockedCountries,
      rateLimit: 'rateLimit' in raw ? raw.rateLimit : base.rateLimit,
    });
    protection = read;
  }

  return {
    // `null` heißt „es gibt den Marker nicht" — `applyGlobalSettings` lehnt das
    // gleich danach mit dem Grund ab, hier wäre eine Vermutung fehl am Platz.
    httpsLines: list(raw.httpsLines) ?? current.httpsLines ?? [],
    adminIps,
    ...(protection ? { protection } : {}),
    ...(typeof raw.crowdsec === 'boolean' ? { crowdsec: raw.crowdsec } : {}),
  };
}

/** Leere Zeilen fallen weg statt abgelehnt zu werden: das Formular hält eine
 *  bereit, damit man tippen kann. Eine halb gefüllte bleibt und fällt in der
 *  Prüfung auf. */
function readHeaders(value: unknown): HeaderRule[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const h = (entry ?? {}) as Record<string, unknown>;
      return { name: String(h.name ?? '').trim(), value: String(h.value ?? '').trim() };
    })
    .filter((rule) => rule.name !== '' || rule.value !== '');
}

function readServers(value: unknown): BackendServerInput[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const s = (entry ?? {}) as Record<string, unknown>;
    return {
      name: String(s.name ?? '').trim(),
      target: String(s.target ?? '').trim(),
      weight: readWeight(s.weight),
    };
  });
}

/**
 * Wie das Ziel angesprochen wird, aus einem Request-Rumpf.
 *
 * Fehlt das Feld, heißt das HTTP: so stand jede Zeile da, bevor es die Frage
 * gab, und ein Aufrufer, der davon nichts weiß, soll nichts verändern. Ein
 * UNBEKANNTER Wert wird durchgereicht und von `validateCreateInput` abgelehnt,
 * aus demselben Grund wie bei `balance`.
 */
export function readBackendTlsInput(value: unknown): BackendTls {
  const raw = String(value ?? '').trim();
  return (raw === '' ? 'off' : raw) as BackendTls;
}

/**
 * Die Gewichtung aus einem Request-Rumpf.
 *
 * Ein fehlendes oder leeres Feld heißt „keine `weight`-Angabe" und nicht 1: ein
 * Aufrufer, der davon nichts weiß, soll HAProxys Vorgabe gelten lassen, und
 * eine hingeschriebene 1 stünde danach in dreißig Zeilen, in denen sie vorher
 * nicht stand. Ein UNBEKANNTER Wert wird durchgereicht und von
 * `validateCreateInput` abgelehnt — `Number` und nicht `parseInt`, damit „2abc"
 * als NaN durchfällt statt als 2 durchzugehen.
 */
export function readWeight(value: unknown): number | null {
  const raw = String(value ?? '').trim();
  return raw === '' ? null : Number(raw);
}
