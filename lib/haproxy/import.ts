/**
 * Eine fremde HAProxy-Konfiguration lesen und in Einträge von HAPM übersetzen.
 *
 * Der Fall: jemand zieht von einem HAProxy, das er bisher von Hand gepflegt
 * hat, zu HAPM um und will seine Domains nicht einzeln abtippen. Gelesen wird
 * eine beliebige `haproxy.cfg`, herauskommen Vorschläge im Modell von HAPM
 * (`CreateServiceInput`, `CreateStreamInput`) und eine Liste dessen, was nicht
 * übernommen wird, mit Zeile und Grund.
 *
 * ── Es wird nicht geraten ──
 *
 * Eine fremde Konfiguration kann alles, was HAProxy kann, HAPM bildet einen
 * kleinen Teil davon ab. Der naheliegende Weg wäre, zu übernehmen, was passt,
 * und den Rest wegzulassen: aus `server web1 10.0.0.1:80 check inter 2s
 * maxconn 50 ssl verify none` würde `server web1 10.0.0.1:80`, und das Ziel
 * spräche danach Klartext mit einem Server, der TLS erwartet. Ein solcher
 * Eintrag stünde grün in der Vorschau und wäre kaputt.
 *
 * Deshalb gilt dieselbe Regel wie bei `extras` in `config.ts`, nur strenger:
 * **ein halb erkannter Eintrag ist ein nicht übernommener Eintrag**, und sein
 * Grund steht daneben. Was übernommen wird, verhält sich in HAPM so wie vorher.
 * Ausnahmen gibt es nur dort, wo HAPM etwas bewusst selbst festlegt (TLS, das
 * Zertifikat, der Name des Cookies, die Form des Healthchecks); sie stehen als
 * Hinweis am Eintrag und nicht still darin.
 *
 * ── Warum die Reihenfolge der Regeln gelesen wird ──
 *
 * HAProxy nimmt die ERSTE passende Weiche. Eine Regel, die HAPM nicht abbilden
 * kann und VOR der Weiche einer Domain steht, nimmt dieser Domain einen Teil
 * ihres Verkehrs weg (`use_backend admin if host_x buero_ips`). Die Weiche
 * allein zu übernehmen hieße, dieses Stück still zu verlieren. Eine Regel, die
 * nie zum Zug kam (dieselbe Domain zweimal, eine Pfad-Regel unter der
 * Hauptweiche), wird dagegen weggelassen und als „kam nie zum Zug" genannt:
 * übernommen verhält sich der Eintrag genau wie vorher.
 *
 * ── Rein ──
 *
 * Text rein, Struktur raus, Importe nur aus `config.ts`, `streams.ts` und
 * `challenge.ts`, die ihrerseits rein sind. Gerechnet wird trotzdem auf dem
 * Server (`/api/haproxy/import/preview`): die Konflikte hängen an der Datei
 * auf der Maschine, und beim Ausführen wird der Text dort ohnehin noch einmal
 * gelesen, statt einer Vorschau aus dem Browser zu glauben. Der Browser nimmt
 * von hier nur die Typen und die Rechnung zum Kontingent.
 */

import {
  HAPROXY_BALANCE,
  STICKY_COOKIE,
  assignServiceId,
  domainCovers,
  findDomainConflict,
  healthcheckPossible,
  isValidBackendName,
  isValidBackendTarget,
  isValidDomain,
  isValidRedirectUrl,
  isValidRoutePath,
  isValidSourceAddress,
  isValidWeight,
  isWildcardDomain,
  parseHaproxyConfig,
  serviceKind,
  validateHeaderRule,
  validateNewService,
  validateScopeName,
  wildcardSuffix,
  type BackendTls,
  type CreateServiceInput,
  type HaproxyBalance,
  type HaproxyScopeInfo,
  type HeaderRule,
  type RedirectTarget,
  type RouteInput,
} from './config';
import {
  STREAM_BALANCE,
  assignStreamId,
  bindConflict,
  validateNewStream,
  type CreateStreamInput,
  type StreamBalance,
} from './streams';
import { planChallenge } from './challenge';
import { findCertificateFor, type AcmeCertificate } from './certs';
import { createTranslator, msg, msgid, type Message, type Translator } from '../i18n/translate';
import type { CertificateSource, Exposure } from '../types';

/* ── Sprache ──
 *
 * Gründe und Hinweise setzen einander zusammen („Zeile 12: …", ein Grund aus
 * einer ACL in dem einer Weiche), deshalb entstehen sie gleich als fertiger
 * Text in einer Sprache und nicht als `Message`. Die Vorschau rechnet in der
 * Sprache der Anfrage (`parseImport(text, t)`), alles andere auf Deutsch: was
 * in einen Lauf übergeht, wird gespeichert und bleibt deutsch.
 *
 * Ein Modulwert statt eines Parameters durch jede Funktion: `parseImport` und
 * `assessImport` laufen synchron durch, dazwischen kommt keine andere Anfrage
 * an die Reihe, und `withTranslator` stellt den vorigen Wert wieder her. */

type Translate = Translator['t'];

const GERMAN: Translate = createTranslator('de').t;
let t: Translate = GERMAN;

function withTranslator<T>(translator: Translate | undefined, work: () => T): T {
  const previous = t;
  t = translator ?? GERMAN;
  try {
    return work();
  } finally {
    t = previous;
  }
}

/** Größer wird keine Konfiguration, die man von Hand pflegt. Die Grenze gilt
 *  im Browser (Datei, Feld) und in der Route. */
export const IMPORT_MAX_BYTES = 1_000_000;

/** Warum dieser Text nicht gelesen wird, oder `null`. Dieselbe Prüfung im
 *  Browser (vor dem Hochladen) und in der Route. */
export function importTextError(text: string): Message | null {
  if (text.trim() === '') return msg('Es wurde keine Konfiguration übergeben.');
  if (new TextEncoder().encode(text).length > IMPORT_MAX_BYTES) {
    return msg('Die Konfiguration ist größer als {size} MB.', { size: IMPORT_MAX_BYTES / 1_000_000 });
  }
  // Ein Nullbyte oder ein Zeichen, das beim Lesen als UTF-8 nicht entziffert
  // wurde: dann war es keine Textdatei.
  if (text.includes('\u0000') || text.includes('�')) return msg('Das ist keine Textdatei.');
  return null;
}

/* ── Die Grenzen von Let's Encrypt ──
 *
 * Stand August 2026 (letsencrypt.org/docs/rate-limits): 50 Zertifikate je
 * registrierter Domain in 7 Tagen, 300 neue Bestellungen je Konto in 3
 * Stunden, 5 gescheiterte Prüfungen je Name und Konto in einer Stunde. Ein
 * Import kann jede davon erreichen, und eine erreichte Grenze heißt Warten,
 * nicht Wiederholen. */
export const LE_CERTS_PER_DOMAIN_WEEK = 50;
export const LE_ORDERS_PER_3H = 300;
export const LE_FAILURES_PER_HOUR = 5;

/* ── Was herauskommt ── */

/** Die Art, wie sie in der Vorschau steht. Dieselben vier wie beim Anlegen. */
export type ImportKind = 'proxy' | 'balance' | 'redirect' | 'tcp';

export interface ImportEntry {
  /**
   * Die Kennung des Vorschlags. Beim Ausführen schickt der Browser nur diese
   * Schlüssel, der Server liest den Text erneut und sucht sie darin: ein
   * Eintrag aus der Vorschau wird nicht geglaubt.
   */
  key: string;
  kind: ImportKind;
  /** Woher er stammt, etwa `frontend https_in → backend web`. */
  source: string;
  /** Die erste Zeile, die zu ihm gehört. */
  line: number;
  domains: string[];
  port: number | null;
  /** Zur Anzeige: Ziele, Pfad-Regeln, Weiterleitung. */
  targets: string[];
  /** Zur Anzeige: Verfahren, Bindung, Healthcheck, Header, Absender. */
  extras: string[];
  /** Was HAPM anders macht als bisher und der Eintrag trotzdem übernimmt. */
  notes: string[];
  /** Warum er nicht übernommen wird. Leer heißt übernehmbar. */
  problems: string[];
  /** Die Eingabe ohne Gruppe und ohne ID. Nur, wenn `problems` leer ist. */
  service: CreateServiceInput | null;
  stream: CreateStreamInput | null;
}

export interface SkippedLine {
  line: number;
  text: string;
  reason: string;
}

export interface ImportResult {
  entries: ImportEntry[];
  skipped: SkippedLine[];
}

/* ── Zeilen ── */

interface Token {
  text: string;
  /** In Anführungszeichen. `''` ist dann ein Wort, kein fehlendes. */
  quoted: boolean;
  /** Ein `$NAME` in doppelten Anführungszeichen: HAProxy setzt dort eine
   *  Umgebungsvariable ein, deren Wert hier niemand kennt. */
  env: boolean;
}

interface Line {
  /** 1-basiert, die erste physische Zeile. */
  no: number;
  /** Zur Anzeige, ohne Kommentar. */
  text: string;
  words: string[];
  env: boolean;
  error: string | null;
}

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t' };

/**
 * Eine Zeile in Wörter zerlegen, so wie HAProxy es tut: Leerraum trennt,
 * `#` beginnt einen Kommentar, doppelte Anführungszeichen kennen Escapes und
 * Umgebungsvariablen, einfache nichts von beidem, ein Backslash maskiert das
 * nächste Zeichen.
 */
function tokenize(text: string): { tokens: Token[]; error: string | null } {
  const tokens: Token[] = [];
  let current = '';
  let started = false;
  let quoted = false;
  let env = false;
  let mode: 'plain' | 'double' | 'single' = 'plain';

  const flush = () => {
    if (started) tokens.push({ text: current, quoted, env });
    current = '';
    started = false;
    quoted = false;
    env = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (mode === 'single') {
      if (ch === "'") mode = 'plain';
      else current += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) {
      const next = text[++i];
      if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
        current += String.fromCharCode(parseInt(text.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        current += ESCAPES[next] ?? next;
      }
      started = true;
      continue;
    }
    if (mode === 'double') {
      if (ch === '"') mode = 'plain';
      else {
        if (ch === '$' && /[A-Za-z_{]/.test(text[i + 1] ?? '')) env = true;
        current += ch;
      }
      continue;
    }
    if (ch === '#') break;
    if (ch === ' ' || ch === '\t') {
      flush();
      continue;
    }
    if (ch === '"' || ch === "'") {
      mode = ch === '"' ? 'double' : 'single';
      started = true;
      quoted = true;
      continue;
    }
    current += ch;
    started = true;
  }
  if (mode !== 'plain') return { tokens, error: t('Ein Anführungszeichen ist nicht geschlossen.') };
  flush();
  return { tokens, error: null };
}

/** Ohne den Kommentar am Ende, für die Anzeige. Grob: ein `#` in
 *  Anführungszeichen bleibt hier stehen, das reicht für einen Blick. */
function displayText(raw: string): string {
  return raw.replace(/\s+#[^"']*$/, '').trim();
}

/**
 * Die Zeilen, ohne Kommentare und Leerzeilen.
 *
 * ── Keine Fortsetzungszeilen ──
 *
 * HAProxy kennt sie nicht: `server web 10.0.0.1:80 \` und `check` darunter
 * lehnt es als zwei kaputte Zeilen ab (geprüft gegen 3.4). Sie hier
 * zusammenzuziehen hieße, etwas zu übernehmen, das HAProxy so nie geladen hat.
 * Eine solche Zeile trägt deshalb einen Fehler und macht ihren Eintrag nicht
 * übernehmbar.
 */
function readLines(text: string): Line[] {
  const raw = text.replace(/^﻿/, '').split(/\r?\n/);
  const out: Line[] = [];
  raw.forEach((source, index) => {
    const { tokens, error } = tokenize(source);
    if (tokens.length === 0 && !error) return;
    const continued = /(^|[^\\])(\\\\)*\\\s*$/.test(source.replace(/\s#.*$/, ''));
    out.push({
      no: index + 1,
      text: displayText(source.replace(/\s+/g, ' ')),
      words: tokens.map((token) => token.text),
      env: tokens.some((token) => token.env),
      error:
        error ??
        (continued
          ? t('Ein \\ am Zeilenende setzt in HAProxy keine Zeile fort. So lädt HAProxy die Datei nicht.')
          : null),
    });
  });
  return out;
}

/* ── Abschnitte ── */

const SECTION_KINDS = new Set([
  'global', 'defaults', 'frontend', 'backend', 'listen', 'userlist', 'peers', 'resolvers',
  'mailers', 'cache', 'ring', 'http-errors', 'program', 'crt-store', 'log-forward', 'fcgi-app',
  'traces', 'acme',
]);

interface Section {
  kind: string;
  name: string | null;
  head: Line;
  body: Line[];
  /** `frontend x from vorgaben`: die benannten Vorgaben, aus denen er erbt. */
  from: string | null;
  /** Der Modus, ausdrücklich oder geerbt. HAProxys eigene Vorgabe ist tcp. */
  mode: string;
  /** Kein `mode` weder hier noch in Vorgaben: HTTP wurde aus dem Inhalt geschlossen. */
  modeAssumed?: boolean;
  /** Kein `mode` und nichts, was auf HTTP deutet: gilt als tcp, kann einem Frontend folgen. */
  modeOpen?: boolean;
}

/**
 * Was nur in mode http geht. Ein Abschnitt, der so etwas enthält und keinen
 * Modus nennt oder erbt, ist ein eingefügter Ausschnitt ohne seinen Block
 * `defaults`: in mode tcp nähme HAProxy ihn gar nicht an.
 */
const HTTP_ONLY = /\b(hdr|hdr_dom|hdr_end|hdr_beg|hdr_reg|req\.hdr|path|path_beg|path_end|path_reg|url|url_beg|method)\(|\bhttp-(request|response|check)\b|\bredirect\b|\boption\s+(httpchk|forwardfor|http-server-close|httplog)\b|\bcookie\b/i;

function looksLikeHttp(section: Section): boolean {
  return section.body.some((line) => HTTP_ONLY.test(line.text));
}

function readSections(lines: Line[], skipped: SkippedLine[]): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const line of lines) {
    const head = line.words[0]?.toLowerCase();
    if (head && SECTION_KINDS.has(head)) {
      const fromAt = line.words.findIndex((w, i) => i > 0 && w.toLowerCase() === 'from');
      current = {
        kind: head,
        name: line.words[1] && fromAt !== 1 ? line.words[1] : null,
        head: line,
        body: [],
        from: fromAt > 0 ? (line.words[fromAt + 1] ?? null) : null,
        mode: 'tcp',
      };
      sections.push(current);
      continue;
    }
    if (!current) {
      skipped.push({ line: line.no, text: line.text, reason: t('Steht vor dem ersten Abschnitt.') });
      continue;
    }
    current.body.push(line);
  }

  // Der Modus: ausdrücklich, sonst aus den benannten Vorgaben, sonst aus dem
  // letzten Block `defaults` davor.
  // `null`: nirgends ausdrücklich genannt.
  const named = new Map<string, string | null>();
  let lastDefaults: string | null = null;
  for (const section of sections) {
    const own = section.body.find((l) => l.words[0]?.toLowerCase() === 'mode')?.words[1]?.toLowerCase() ?? null;
    const inherited: string | null = section.from ? (named.get(section.from) ?? lastDefaults) : lastDefaults;
    if (section.kind === 'defaults') {
      const value: string | null = own ?? (section.from ? inherited : null);
      section.mode = value ?? 'tcp';
      // Auch ein benannter Block gilt für alles danach, das kein `from` nennt:
      // HAProxy nimmt immer den letzten `defaults` davor.
      if (section.name) named.set(section.name, value);
      lastDefaults = value;
      continue;
    }
    const known = own ?? inherited;
    if (known) {
      section.mode = known;
    } else if (looksLikeHttp(section)) {
      section.mode = 'http';
      section.modeAssumed = true;
    } else {
      section.mode = 'tcp';
      section.modeOpen = true;
    }
  }

  // Ein Backend ohne Modus folgt dem HTTP-Frontend, das es benutzt.
  const usedByHttp = new Set<string>();
  for (const section of sections) {
    if (section.mode !== 'http' || section.kind === 'backend') continue;
    for (const line of section.body) {
      const kw = line.words[0]?.toLowerCase();
      if ((kw === 'use_backend' || kw === 'default_backend') && line.words[1]) usedByHttp.add(line.words[1]);
    }
  }
  for (const section of sections) {
    if (section.kind === 'backend' && section.modeOpen && section.name && usedByHttp.has(section.name)) {
      section.mode = 'http';
      section.modeAssumed = true;
      section.modeOpen = false;
    }
  }
  return sections;
}

/* ── Bedingungen ──
 *
 * Eine ACL-Zeile wird auf ihre Bedeutung gelesen: welche Domains, welche
 * Pfade, welche Absender. Was keine davon ist, ist `other` mit Grund. */

type Meaning =
  | { kind: 'host'; domains: string[]; notes: string[] }
  | { kind: 'path'; paths: string[] }
  | { kind: 'src'; sources: string[] }
  | { kind: 'ssl' }
  | { kind: 'other'; reason: string };

/** `hdr(host),lower,field(1,:)` → Fetch, Argument, Umwandlungen. */
function splitCriterion(criterion: string): { fetch: string; arg: string | null; converters: string[] } {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of criterion) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  const head = /^([A-Za-z0-9_.]+)(?:\(([^)]*)\))?$/.exec(parts[0]);
  return {
    fetch: (head?.[1] ?? parts[0]).toLowerCase(),
    arg: head?.[2] !== undefined ? head[2].trim().toLowerCase() : null,
    converters: parts.slice(1).map((c) => c.trim().toLowerCase()),
  };
}

/** Umwandlungen, die am Vergleich eines Hostnamens nichts ändern, das HAPM
 *  nicht auch so vergleicht: klein schreiben, den Port abschneiden. */
const HOST_CONVERTERS = new Set(['lower', 'field(1,:)']);

function classifyAcl(words: string[]): Meaning {
  if (words.length === 0) return { kind: 'other', reason: t('Leere Bedingung.') };
  const { fetch, arg, converters } = splitCriterion(words[0]);

  let caseInsensitive = false;
  let method: string | null = null;
  const values: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (values.length === 0 && word === '-i') caseInsensitive = true;
    else if (values.length === 0 && word === '-m') method = (words[++i] ?? '').toLowerCase();
    else if (values.length === 0 && word === '-f') {
      return { kind: 'other', reason: t('Die Werte stehen in einer Datei (-f), die hier nicht vorliegt.') };
    } else if (values.length === 0 && word === '--') continue;
    else if (values.length === 0 && /^-[a-zA-Z]$/.test(word)) {
      return { kind: 'other', reason: t('Den Schalter {flag} kennt HAPM an einer Bedingung nicht.', { flag: word }) };
    } else values.push(word);
  }

  const host = /^(?:req\.)?hdr(_end|_dom|_beg|_reg|_sub|_len|_cnt|_val|_ip)?$/.exec(fetch);
  const sni = /^(?:req\.ssl_sni|req_ssl_sni|ssl_fc_sni)(_end|_reg)?$/.exec(fetch);
  if ((host && arg === 'host') || (sni && arg === null)) {
    const suffix = (host ?? sni)![1] ?? '';
    const bySuffix = suffix === '' ? null : suffix.slice(1);
    if (bySuffix && method) {
      return {
        kind: 'other',
        reason: t('{criterion} mit -m {method} lässt offen, welcher Vergleich gilt.', { criterion: words[0], method }),
      };
    }
    const match = bySuffix ?? method ?? 'str';
    if (!['str', 'end', 'dom'].includes(match)) {
      return {
        kind: 'other',
        reason: t('Der Vergleich „{match}" auf den Hostnamen lässt sich nicht als Liste von Domains schreiben.', { match }),
      };
    }
    const unknown = converters.find((c) => !HOST_CONVERTERS.has(c));
    if (unknown) return { kind: 'other', reason: t('Die Umwandlung {converter} kennt HAPM nicht.', { converter: unknown }) };
    if (values.length === 0) return { kind: 'other', reason: t('Die Bedingung nennt keine Domain.') };

    // Ob mit `-i` oder ohne: HAPM vergleicht klein, und Domains sind es auch.
    const domains: string[] = [];
    const notes: string[] = [];
    for (const raw of values) {
      const value = raw.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
      if (value.includes('*')) {
        return {
          kind: 'other',
          reason: t('{value}: ein Stern ist in diesem Vergleich ein Zeichen und keine Wildcard.', { value: raw }),
        };
      }
      if (match === 'str') domains.push(value);
      else if (match === 'end' && value.startsWith('.')) domains.push(`*${value}`);
      else {
        domains.push(value, `*.${value}`);
        notes.push(
          match === 'dom'
            ? t(
                '{criterion} {value} trifft den Namen auch als Teil eines längeren. Übernommen werden {domain} und *.{domain}.',
                { criterion: words[0], value: raw, domain: value }
              )
            : t(
                '{criterion} {value} ohne führenden Punkt trifft auch Namen wie x{domain}. Übernommen werden {domain} und *.{domain}.',
                { criterion: words[0], value: raw, domain: value }
              )
        );
      }
    }
    const bad = domains.find((d) => !isValidDomain(d));
    if (bad) return { kind: 'other', reason: t('{domain} ist keine Domain, die HAPM anlegen kann.', { domain: bad }) };
    return { kind: 'host', domains: unique(domains), notes };
  }

  const path = fetch === 'path_beg' || (fetch === 'path' && method === 'beg');
  if (path && arg === null) {
    if (fetch === 'path_beg' && method) {
      return {
        kind: 'other',
        reason: t('{criterion} mit -m {method} lässt offen, welcher Vergleich gilt.', { criterion: words[0], method }),
      };
    }
    if (caseInsensitive) {
      return { kind: 'other', reason: t('Einen Pfadvergleich ohne Groß- und Kleinschreibung (-i) kennt HAPM nicht.') };
    }
    if (converters.length > 0) {
      return { kind: 'other', reason: t('Die Umwandlung {converter} kennt HAPM nicht.', { converter: converters[0] }) };
    }
    if (values.length === 0) return { kind: 'other', reason: t('Die Bedingung nennt keinen Pfad.') };
    const bad = values.find((p) => !isValidRoutePath(p));
    if (bad) return { kind: 'other', reason: t('{path} ist kein Pfad, wie HAPM ihn vergleicht.', { path: bad }) };
    return { kind: 'path', paths: values };
  }

  if (fetch === 'src' && arg === null && converters.length === 0 && !method) {
    const bad = values.find((v) => !isValidSourceAddress(v));
    if (bad || values.length === 0) {
      return { kind: 'other', reason: t('{value}: keine Adresse oder kein CIDR-Block.', { value: bad ?? 'src' }) };
    }
    return { kind: 'src', sources: values };
  }

  if (fetch === 'ssl_fc' && values.length === 0 && converters.length === 0) return { kind: 'ssl' };

  return {
    kind: 'other',
    reason: t('Die Bedingung {condition} lässt sich in HAPM nicht abbilden.', { condition: words.join(' ') }),
  };
}

/** Mehrere `acl`-Zeilen mit demselben Namen sind in HAProxy ein Oder. */
function combine(meanings: Meaning[]): Meaning {
  const kinds = new Set(meanings.map((m) => m.kind));
  if (kinds.size !== 1) {
    const other = meanings.find((m) => m.kind === 'other');
    return other ?? { kind: 'other', reason: t('Die ACL mischt Bedingungen verschiedener Art.') };
  }
  const first = meanings[0];
  if (first.kind === 'host') {
    const hosts = meanings as Extract<Meaning, { kind: 'host' }>[];
    return {
      kind: 'host',
      domains: unique(hosts.flatMap((m) => m.domains)),
      notes: hosts.flatMap((m) => m.notes),
    };
  }
  if (first.kind === 'path') {
    return { kind: 'path', paths: unique((meanings as Extract<Meaning, { kind: 'path' }>[]).flatMap((m) => m.paths)) };
  }
  if (first.kind === 'src') {
    return { kind: 'src', sources: unique((meanings as Extract<Meaning, { kind: 'src' }>[]).flatMap((m) => m.sources)) };
  }
  return first;
}

interface Term {
  negated: boolean;
  meaning: Meaning;
  label: string;
}

/** Eine Bedingung als Oder von Unds. HAProxy kennt keine Klammern: `a b or c`
 *  heißt (a und b) oder c. */
function parseCondition(words: string[], acls: Map<string, Meaning>): Term[][] {
  const groups: Term[][] = [[]];
  for (let i = 0; i < words.length; i++) {
    let word = words[i];
    if (word === 'or' || word === '||') {
      groups.push([]);
      continue;
    }
    let negated = false;
    if (word === '!') {
      negated = true;
      word = words[++i] ?? '';
    } else if (word.startsWith('!')) {
      negated = true;
      word = word.slice(1);
    }
    if (word === '{') {
      const inner: string[] = [];
      while (i + 1 < words.length && words[i + 1] !== '}') inner.push(words[++i]);
      i++;
      groups[groups.length - 1].push({ negated, meaning: classifyAcl(inner), label: `{ ${inner.join(' ')} }` });
      continue;
    }
    const meaning = acls.get(word) ?? {
      kind: 'other' as const,
      reason: t('Die ACL {acl} ist nicht definiert oder eine eingebaute, die HAPM nicht abbildet.', { acl: word }),
    };
    groups[groups.length - 1].push({ negated, meaning, label: word });
  }
  return groups.filter((g) => g.length > 0);
}

/** Aktion und Bedingung trennen: das erste `if`/`unless` außerhalb von `{ }`. */
function splitRule(words: string[]): { action: string[]; cond: string[] | null; unless: boolean } {
  let depth = 0;
  for (let i = 0; i < words.length; i++) {
    if (words[i] === '{') depth++;
    if (words[i] === '}') depth--;
    if (depth === 0 && (words[i] === 'if' || words[i] === 'unless')) {
      return { action: words.slice(0, i), cond: words.slice(i + 1), unless: words[i] === 'unless' };
    }
  }
  return { action: words, cond: null, unless: false };
}

/** Die Domains, an denen eine Regel hängt. Nur die bejahten: `!host_a` meint
 *  alle anderen und damit keine bestimmte. */
function hostDomains(terms: Term[]): string[] {
  return unique(
    terms.flatMap((term) => (term.meaning.kind === 'host' && !term.negated ? term.meaning.domains : []))
  );
}

/* ── Kleinigkeiten ── */

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** Exakte Domains zuerst, dann die Wildcards: so schreibt `hostAclLines`
 *  sie, und so kommen sie zurück. Eine andere Reihenfolge käme beim ersten
 *  Speichern umsortiert heraus. */
function orderDomains(domains: string[]): string[] {
  return [...domains.filter((d) => !isWildcardDomain(d)), ...domains.filter(isWildcardDomain)];
}

const DURATION_FACTOR: Record<string, number> = { us: 0.001, ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function durationMs(value: string): number | null {
  const match = /^(\d+)(us|ms|s|m|h|d)?$/.exec(value);
  return match ? Number(match[1]) * DURATION_FACTOR[match[2] ?? 'ms'] : null;
}

/** Was `headerLine` als Wert schreiben kann: Text. `%%` ist ein
 *  Prozentzeichen, jedes andere `%` ein Ausdruck (`%[src]`, `%T`). */
function literalHeaderValue(value: string): string | null {
  if (/%(?!%)/.test(value.replace(/%%/g, ''))) return null;
  return value.replace(/%%/g, '%');
}

/* ── server-Zeilen ── */

interface ServerRead {
  name: string;
  target: string;
  check: boolean;
  weight: number | null;
  cookie: string | null;
  tls: BackendTls;
  notes: string[];
}

/** Was in `global` steht und eine server-Zeile ändert. */
interface GlobalRead {
  /** `ssl-server-verify none`: ein `ssl` ohne `verify` prüft dann nicht. */
  serverVerifyNone: boolean;
}

const NO_GLOBAL: GlobalRead = { serverVerifyNone: false };

/** Ein SNI, der die Domain der Anfrage ist: so, wie HAPM ihn schreibt, oder
 *  gleichwertig (ohne Port, kleingeschrieben). */
const HOST_SNI = /^(?:req\.)?hdr\(host\)(?:,field\(1,:\))?(?:,lower)?$/i;

/**
 * Die HTTPS-Wörter einer server-Zeile als `BackendTls`, oder ein Grund.
 *
 * HAPM schreibt genau zwei Formen (`backendTlsParams`). Übernommen wird, was
 * sich danach so verhält wie vorher: `verify none` mit beliebigem SNI (das
 * Zertifikat wird nicht geprüft, der SNI wählt nur aus, welches das Ziel
 * zeigt), `verify required` nur gegen die CAs des Systems und mit der Domain
 * der Anfrage als SNI. Mit einem festen SNI oder ohne prüfte HAProxy den
 * Namen anders als HAPM danach, und ein Ziel, das heute durchkommt, fiele
 * durch.
 */
function readServerTls(
  name: string,
  params: { ssl: boolean; verify: string | null; caFile: string | null; sni: string | null; tlsWords: string[] },
  global: GlobalRead,
  notes: string[]
): BackendTls | { problem: string } {
  if (!params.ssl) {
    if (params.tlsWords.length === 0) return 'off';
    return { problem: t('server {name}: {options} ohne ssl kennt HAPM nicht.', { name, options: params.tlsWords.join(' ') }) };
  }
  const verify = params.verify ?? (global.serverVerifyNone ? 'none' : 'required');
  if (verify === 'none') {
    if (params.caFile) return { problem: t('server {name}: ca-file mit verify none kennt HAPM nicht.', { name }) };
    if (!params.sni || !HOST_SNI.test(params.sni)) {
      notes.push(t('server {name}: HAPM schickt dem Ziel die Domain der Anfrage als SNI.', { name }));
    }
    return 'insecure';
  }
  if (verify !== 'required') {
    return { problem: t('server {name}: verify {verify} kennt HAProxy nicht.', { name, verify }) };
  }
  if (!params.caFile) {
    return {
      problem: t('server {name}: ssl prüft das Zertifikat, aber ohne ca-file. So lädt HAProxy die Zeile nicht.', { name }),
    };
  }
  if (params.caFile !== '@system-ca') {
    return {
      problem: t('server {name}: Eine eigene CA-Datei ({file}) kennt HAPM nicht, nur die CAs des Systems (@system-ca).', {
        name,
        file: params.caFile,
      }),
    };
  }
  if (!params.sni || !HOST_SNI.test(params.sni)) {
    return {
      problem: t(
        'server {name}: HAPM prüft das Zertifikat gegen die Domain der Anfrage (sni req.hdr(host)). Hier wird es anders geprüft, das Ziel könnte danach durchfallen.',
        { name }
      ),
    };
  }
  return 'verify';
}

function readServer(words: string[], problems: string[], global: GlobalRead = NO_GLOBAL): ServerRead | null {
  const [, name, address, ...params] = words;
  if (!name || !address) {
    problems.push(t('„{line}": server-Zeile ohne Name oder Adresse.', { line: words.join(' ') }));
    return null;
  }
  if (!isValidBackendName(name)) {
    problems.push(t('Der Servername {name} enthält Zeichen, die HAPM nicht schreibt.', { name }));
    return null;
  }

  const addr = address.replace(/^(ipv4|tcp|tcp4)@/i, '');
  if (/^(unix|abns|ipv6|tcp6|fd|sockpair)@/i.test(addr) || addr.startsWith('/')) {
    problems.push(t('server {name}: die Adresse {address} ist kein host:port.', { name, address }));
    return null;
  }
  if (addr.startsWith('[') || (addr.match(/:/g) ?? []).length > 1) {
    problems.push(t('server {name}: IPv6-Ziele ({address}) kennt HAPM noch nicht.', { name, address }));
    return null;
  }
  if (!addr.includes(':')) {
    problems.push(t('server {name}: {address} hat keinen Port. HAProxy nähme dann den Port der Anfrage.', { name, address }));
    return null;
  }
  if (!isValidBackendTarget(addr)) {
    problems.push(t('server {name}: {address} ist kein Ziel, wie HAPM es schreibt (host:port).', { name, address }));
    return null;
  }

  let check = false;
  let weight: number | null = null;
  let cookie: string | null = null;
  const tls = { ssl: false, verify: null as string | null, caFile: null as string | null, sni: null as string | null, tlsWords: [] as string[] };
  const rest: string[] = [];
  for (let i = 0; i < params.length; i++) {
    const param = params[i];
    if (param === 'check') check = true;
    else if (param === 'weight') {
      const value = Number(params[++i]);
      if (!isValidWeight(value)) {
        problems.push(t('server {name}: die Gewichtung {weight} nimmt HAProxy nicht.', { name, weight: String(params[i]) }));
        return null;
      }
      weight = value;
    } else if (param === 'cookie') cookie = params[++i] ?? '';
    else if (param === 'ssl') tls.ssl = true;
    // `check-ssl` ist bei `ssl` die Vorgabe, `check-sni` schreibt HAPM selbst
    // (die Hauptdomain, `backendCheckSni`).
    else if (param === 'check-ssl') tls.tlsWords.push(param);
    else if (param === 'check-sni') tls.tlsWords.push(param, params[++i] ?? '');
    else if (param === 'verify') tls.tlsWords.push(param, (tls.verify = (params[++i] ?? '').toLowerCase()));
    else if (param === 'ca-file') tls.tlsWords.push(param, (tls.caFile = params[++i] ?? ''));
    else if (param === 'sni') tls.tlsWords.push(param, (tls.sni = params[++i] ?? ''));
    else rest.push(param);
  }
  if (rest.length > 0) {
    problems.push(t('server {name}: {options} bildet HAPM nicht ab.', { name, options: rest.join(' ') }));
    return null;
  }
  const notes: string[] = [];
  const mode = readServerTls(name, tls, global, notes);
  if (typeof mode !== 'string') {
    problems.push(mode.problem);
    return null;
  }
  return { name, target: addr, check, weight, cookie, tls: mode, notes };
}

/* ── Was ein Backend- oder listen-Abschnitt hergibt ── */

interface BindRead {
  port: number | null;
  ssl: boolean;
  wildcard: boolean;
  ipv6: boolean;
  params: string[];
  quic: boolean;
}

interface ProxyRead {
  servers: ServerRead[];
  balance: string | null;
  cookie: { name: string; options: string[] } | null;
  httpchk: string | null;
  responseHeaders: HeaderRule[];
  requestHeaders: HeaderRule[];
  tunnel: boolean;
  redirect: RedirectTarget | null;
  sources: string[];
  sourceRules: number;
  tcpCheck: boolean;
  binds: BindRead[];
  problems: string[];
  notes: string[];
}

function readBind(words: string[]): BindRead[] {
  const params = words.slice(2);
  const ssl = params.includes('ssl');
  return (words[1] ?? '').split(',').map((raw) => {
    const quic = /^quic[46]?@/i.test(raw);
    const address = raw.replace(/^(ipv4|ipv6|tcp|tcp4|tcp6|quic4|quic6|udp|udp4|udp6)@/i, '');
    const cut = address.lastIndexOf(':');
    const host = cut === -1 ? address : address.slice(0, cut);
    const portText = cut === -1 ? '' : address.slice(cut + 1);
    const port = /^\d{1,5}$/.test(portText) ? Number(portText) : null;
    return {
      port,
      ssl,
      quic,
      wildcard: ['', '*', '0.0.0.0', '::', '[::]'].includes(host),
      ipv6: host.includes(':') || /^ipv6@|^tcp6@/i.test(raw),
      params,
    };
  });
}

/** Ein `http-request`/`redirect` mit Weiterleitung, ohne `if`. */
function readRedirect(
  words: string[]
): { kind: 'scheme' } | { kind: 'target'; target: RedirectTarget | null; problems: string[] } | null {
  const type = words[0]?.toLowerCase();
  if (type === 'scheme') return { kind: 'scheme' };
  if (type !== 'location' && type !== 'prefix') return null;
  const to = words[1] ?? '';
  const problems: string[] = [];
  let permanent = false;
  for (let i = 2; i < words.length; i++) {
    if (words[i] === 'code') {
      const code = words[++i];
      if (code === '301') permanent = true;
      else if (code !== '302') problems.push(t('Den Code {code} kennt HAPM nicht, nur 301 und 302.', { code: code ?? '?' }));
    } else {
      problems.push(t('Die Angabe {option} an der Weiterleitung kennt HAPM nicht.', { option: String(words[i]) }));
    }
  }
  if (!isValidRedirectUrl(to)) {
    problems.push(t('Das Ziel {target} ist keine vollständige Adresse, wie HAPM sie verlangt (https://…).', { target: to }));
  }
  return {
    kind: 'target',
    target: problems.length === 0 ? { to, keepPath: type === 'prefix', permanent } : null,
    problems,
  };
}

function readProxyBody(section: Section, global: GlobalRead = NO_GLOBAL): ProxyRead {
  const read: ProxyRead = {
    servers: [],
    balance: null,
    cookie: null,
    httpchk: null,
    responseHeaders: [],
    requestHeaders: [],
    tunnel: false,
    redirect: null,
    sources: [],
    sourceRules: 0,
    tcpCheck: false,
    binds: [],
    problems: [],
    notes: [],
  };
  const problem = (line: Line, reason: string) => read.problems.push(t('Zeile {line}: {reason}', { line: line.no, reason }));
  const tcp = section.mode === 'tcp';
  const srcAcls = new Map<string, Meaning>();
  for (const line of section.body) {
    if (line.words[0]?.toLowerCase() === 'acl' && line.words[1]) {
      srcAcls.set(line.words[1], combine([...(srcAcls.has(line.words[1]) ? [srcAcls.get(line.words[1])!] : []), classifyAcl(line.words.slice(2))]));
    }
  }

  for (const line of section.body) {
    const w = line.words;
    const kw = w[0].toLowerCase();
    if (line.error) {
      problem(line, line.error);
      continue;
    }
    if (line.env) {
      problem(line, t('„{line}" setzt eine Umgebungsvariable ein, deren Wert hier niemand kennt.', { line: line.text }));
      continue;
    }
    if (kw === 'server') {
      const server = readServer(w, read.problems, global);
      if (server) {
        if (read.servers.some((s) => s.name === server.name)) {
          problem(line, t('Der Servername {name} steht doppelt.', { name: server.name }));
        } else {
          read.servers.push(server);
          read.notes.push(...server.notes);
        }
      }
      continue;
    }
    // Der Modus steht schon in `section.mode`, und ob er passt, prüft der
    // Aufrufer: er weiß, wovor der Abschnitt steht.
    if (kw === 'mode') continue;
    if (kw === 'log' && w[1] === 'global' && w.length === 2) continue;
    if (kw === 'balance') {
      if (w.length === 2 && read.balance === null) read.balance = w[1].toLowerCase();
      else problem(line, t('„{line}": ein Verfahren mit Parameter oder ein zweites kennt HAPM nicht.', { line: line.text }));
      continue;
    }
    if (kw === 'cookie' && !tcp) {
      read.cookie = { name: w[1] ?? '', options: w.slice(2).map((o) => o.toLowerCase()) };
      continue;
    }
    if (kw === 'option' && w[1] === 'httpchk' && !tcp) {
      read.httpchk = line.text;
      continue;
    }
    if (kw === 'http-check' && !tcp) {
      read.httpchk ??= line.text;
      continue;
    }
    if (kw === 'option' && w[1] === 'forwardfor' && !tcp) {
      read.notes.push(
        t('option forwardfor entfällt: HAPM setzt X-Forwarded-For in seinen globalen Einstellungen für alle Ziele.')
      );
      continue;
    }
    if (kw === 'option' && w[1] === 'tcplog' && tcp && w.length === 2) continue;
    if (kw === 'option' && w[1] === 'tcp-check' && tcp && w.length === 2) {
      read.tcpCheck = true;
      continue;
    }
    if (kw === 'timeout' && w[1] === 'tunnel' && !tcp) {
      if (w.length === 3 && durationMs(w[2]) === 3_600_000) read.tunnel = true;
      else problem(line, t('timeout tunnel {value}: HAPM kennt für lange Verbindungen genau eine Stunde.', { value: w[2] ?? '' }));
      continue;
    }
    if ((kw === 'http-request' || kw === 'http-response') && w[1] === 'set-header' && !tcp) {
      const direction = kw === 'http-request' ? 'request' : 'response';
      const value = w.length === 4 ? literalHeaderValue(w[3]) : null;
      const rule = value === null ? null : { name: w[2], value };
      const invalid = rule ? validateHeaderRule(rule) : null;
      if (!rule) {
        problem(
          line,
          t('„{line}": ein Header mit Ausdruck oder Bedingung lässt sich nur als fester Text übernehmen.', { line: line.text })
        );
      } else if (invalid) {
        problem(line, t(invalid));
      } else {
        (direction === 'request' ? read.requestHeaders : read.responseHeaders).push(rule);
      }
      continue;
    }
    if (!tcp && (kw === 'redirect' || (kw === 'http-request' && w[1] === 'redirect'))) {
      const { action, cond } = splitRule(w.slice(kw === 'redirect' ? 1 : 2));
      const redirect = readRedirect(action);
      if (cond || !redirect || redirect.kind !== 'target' || !redirect.target || read.redirect) {
        problem(
          line,
          redirect?.kind === 'target' && redirect.problems.length > 0
            ? redirect.problems.join(' ')
            : t('„{line}": nur eine Weiterleitung ohne Bedingung lässt sich übernehmen.', { line: line.text })
        );
      } else {
        read.redirect = redirect.target;
      }
      continue;
    }
    if (kw === 'tcp-request' && (w[1] === 'connection' || w[1] === 'content') && w[2] === 'reject') {
      const { cond, unless } = splitRule(w.slice(3));
      const terms = cond ? parseCondition(cond, srcAcls) : [];
      const src =
        terms.length === 1 && terms[0].length === 1 && terms[0][0].meaning.kind === 'src'
          ? (terms[0][0].meaning as Extract<Meaning, { kind: 'src' }>).sources
          : null;
      const allowList = src && (unless ? !terms[0][0].negated : terms[0][0].negated);
      if (tcp && src && allowList) {
        read.sources = src;
        read.sourceRules++;
      } else {
        problem(line, t('„{line}": HAPM kennt hier nur eine Liste erlaubter Absender.', { line: line.text }));
      }
      continue;
    }
    if (kw === 'acl') continue;
    if (kw === 'bind') {
      read.binds.push(...readBind(w));
      continue;
    }
    if (kw === 'stats') {
      problem(line, t('Die Statistikseite von HAProxy übernimmt HAPM nicht. Es zeigt eigene Zahlen.'));
      continue;
    }
    problem(line, t('„{line}" bildet HAPM nicht ab.', { line: line.text }));
  }
  if (read.sourceRules > 1) read.problems.push(t('Mehrere Absenderlisten: HAPM kennt eine.'));
  return read;
}

/* ── Frontends ── */

interface DomainRoute {
  main: { backend: string; line: number } | null;
  redirect: { target: RedirectTarget; line: number } | null;
  paths: { paths: string[]; backend: string; line: number }[];
  problems: string[];
  notes: string[];
  sources: string[];
  line: number;
}

function emptyRoute(line: number): DomainRoute {
  return { main: null, redirect: null, paths: [], problems: [], notes: [], sources: [], line };
}

/** Aktionen, die einen Besucher abweisen oder nach einem Passwort fragen (hinter `http-request` oder `tcp-request connection|content|session`). */
const ACCESS_ACTIONS = /^((connection|content|session) )?(deny|auth|tarpit|reject|silent-drop|return)( |$)/i;

/** Zeilen eines Frontends, die nur es selbst betreffen und keine Domain:
 *  Ports, Timeouts, Log. HAPM bringt eigene mit. Sie stehen gesammelt in
 *  einer Zeile, nicht je einzeln. */
const FRONTEND_SETTINGS = new Set([
  'bind', 'mode', 'option', 'no', 'timeout', 'log', 'maxconn', 'compression', 'capture', 'errorfile',
  'errorfiles', 'description', 'unique-id-format', 'unique-id-header', 'rate-limit', 'monitor-uri',
  'log-format', 'log-tag', 'declare', 'backlog', 'id', 'enabled', 'disabled', 'filter', 'errorloc',
  'errorloc302', 'errorloc303', 'max-keep-alive-queue', 'http-reuse', 'email-alert',
]);

/** Der Hinweis auf ein Frontend ohne TLS. Er fällt weg, sobald dieselbe Domain
 *  auch über HTTPS lief (`isNoTlsNote`). */
function noTlsNote(section: string): string {
  return t('Lief bisher ohne TLS ({section}). In HAPM läuft es über HTTPS mit eigenem Zertifikat, Port 80 leitet um.', {
    section,
  });
}

/** Erkannt am Anfang des Textes in der Sprache, in der gerade gerechnet wird. */
function isNoTlsNote(note: string): boolean {
  const [head] = noTlsNote('\u0000').split('\u0000');
  return note.startsWith(head);
}

/** Ob `q` (früher) den Verkehr von `p` (später) schon wegnimmt. */
function shadows(q: string, p: string): boolean {
  if (!isWildcardDomain(q)) return false;
  return isWildcardDomain(p) ? domainCovers(q, `x${wildcardSuffix(p)}`) : domainCovers(q, p);
}

interface FrontendContext {
  routes: Map<string, DomainRoute>;
  skipped: SkippedLine[];
  usedBackends: Set<string>;
  backendNames: Set<string>;
}

function readHttpFrontend(section: Section, ctx: FrontendContext): void {
  const label = `${section.kind} ${section.name ?? ''}`.trim();
  const acls = new Map<string, Meaning>();
  for (const line of section.body) {
    if (line.words[0]?.toLowerCase() !== 'acl' || !line.words[1]) continue;
    const name = line.words[1];
    const meaning = classifyAcl(line.words.slice(2));
    acls.set(name, acls.has(name) ? combine([acls.get(name)!, meaning]) : meaning);
  }

  const local = new Map<string, DomainRoute>();
  const routeOf = (domain: string, line: number) => {
    if (!local.has(domain)) local.set(domain, emptyRoute(line));
    return local.get(domain)!;
  };
  const skip = (line: Line, reason: string) => ctx.skipped.push({ line: line.no, text: line.text, reason });
  const taint = (domains: string[], line: Line, reason: string) => {
    for (const domain of domains) routeOf(domain, line.no).problems.push(t('Zeile {line}: {reason}', { line: line.no, reason }));
  };

  const binds: BindRead[] = [];
  const settings: Line[] = [];
  const redirects: Line[] = [];
  const rules: Line[] = [];
  const others: Line[] = [];
  /** Was für jede Domain dieses Frontends ein Grund ist, sie nicht zu übernehmen. */
  const frontendWide: { line: Line; reason: string }[] = [];
  let defaultBackend: Line | null = null;
  let stats = false;

  for (const line of section.body) {
    const kw = line.words[0].toLowerCase();
    if (line.error) skip(line, line.error);
    else if (kw === 'acl') continue;
    else if (kw === 'bind') {
      binds.push(...readBind(line.words));
      settings.push(line);
    } else if (kw === 'server' && section.kind === 'listen') continue;
    else if (FRONTEND_SETTINGS.has(kw)) settings.push(line);
    else if (kw === 'stats') {
      // Eine Zeile für die ganze Statistikseite, nicht eine je `stats …`.
      if (!stats) skip(line, t('Die Statistikseite von HAProxy übernimmt HAPM nicht. Es zeigt eigene Zahlen.'));
      stats = true;
    } else if (kw === 'default_backend') defaultBackend = line;
    else if (kw === 'use_backend') rules.push(line);
    else if (kw === 'redirect' || (kw === 'http-request' && line.words[1] === 'redirect')) redirects.push(line);
    else others.push(line);
  }

  if (settings.length > 0) {
    const keywords = unique(settings.map((l) => l.words[0].toLowerCase()));
    ctx.skipped.push({
      line: settings[0].no,
      text: `${label}: ${keywords.join(', ')}`,
      reason: t(
        binds.some((b) => b.ssl)
          ? 'Ports, TLS, Timeouts und Protokoll eines Frontends übernimmt HAPM nicht: es bringt sein eigenes Frontend mit. Auch die Zertifikate hinter „crt" nicht, sie werden neu ausgestellt.'
          : 'Ports, TLS, Timeouts und Protokoll eines Frontends übernimmt HAPM nicht: es bringt sein eigenes Frontend mit.'
      ),
    });
  }

  /* Eine Regel ohne Domain vor den Weichen: sie nimmt jeder Domain dieses
   * Frontends etwas weg, und HAPM hat keine Stelle dafür. */
  let catchAll: Line | null = null;

  /* Erst die Weiterleitungen: `http-request` läuft in HAProxy vor jedem
   * `use_backend`, egal wo es in der Datei steht. */
  for (const line of redirects) {
    const legacy = line.words[0].toLowerCase() === 'redirect';
    const { action, cond, unless } = splitRule(line.words.slice(legacy ? 1 : 2));
    const redirect = readRedirect(action);
    if (redirect?.kind === 'scheme') {
      skip(line, t('Die Umleitung auf HTTPS macht HAPM selbst, auf Port 80.'));
      continue;
    }
    if (!redirect) {
      skip(line, t('Diese Art Weiterleitung kennt HAPM nicht.'));
      continue;
    }
    if (line.env) {
      skip(line, t('Die Zeile setzt eine Umgebungsvariable ein, deren Wert hier niemand kennt.'));
      catchAll ??= line;
      continue;
    }
    const groups = cond ? parseCondition(cond, acls) : [];
    const domains = hostDomains(groups.flat());
    const plain =
      !unless &&
      groups.length > 0 &&
      groups.every((g) => g.length === 1 && !g[0].negated && g[0].meaning.kind === 'host');
    if (domains.length === 0) {
      skip(line, t('Die Weiterleitung hängt an keiner Domain und gälte für alle. Das kennt HAPM nicht.'));
      catchAll ??= line;
      continue;
    }
    if (!plain || redirect.problems.length > 0 || !redirect.target) {
      const reason = !plain
        ? t('Die Weiterleitung hat eine Bedingung über die Domain hinaus.')
        : redirect.problems.join(' ');
      skip(line, reason);
      taint(domains, line, reason);
      continue;
    }
    for (const domain of domains) {
      const route = routeOf(domain, line.no);
      // Wie bei den Weichen: leitet eine Wildcard davor schon weiter, kam diese
      // Regel bisher nicht zum Zug. In HAPM stünde die genaue Domain davor.
      const earlier = [...local.entries()].find(([other, r]) => other !== domain && r.redirect && shadows(other, domain));
      if (earlier && !route.redirect) {
        route.problems.push(
          t(
            'Zeile {line}: {domain} (Zeile {earlier}) greift vorher. In HAPM käme diese Domain zuerst zum Zug, das änderte, wohin ihr Verkehr geht.',
            { line: line.no, domain: earlier[0], earlier: String(earlier[1].redirect?.line ?? earlier[1].line) }
          )
        );
      }
      if (route.redirect) {
        skip(
          line,
          t('{domain} wird schon in Zeile {line} weitergeleitet. Diese Regel kam nie zum Zug.', {
            domain,
            line: route.redirect.line,
          })
        );
        continue;
      }
      route.redirect = { target: redirect.target, line: line.no };
    }
  }

  /* Die Weichen, in ihrer Reihenfolge. */
  for (const line of rules) {
    const { action, cond, unless } = splitRule(line.words.slice(1));
    const backend = action[0] ?? '';
    if (line.env || backend.includes('%[')) {
      skip(line, t('Die Weiche bestimmt ihr Backend erst zur Laufzeit (Ausdruck oder Map-Datei). Das kennt HAPM nicht.'));
      catchAll ??= line;
      continue;
    }
    ctx.usedBackends.add(backend);
    if (!ctx.backendNames.has(backend)) {
      skip(line, t('Das Backend {backend} steht nicht in der Datei.', { backend }));
      continue;
    }
    if (!cond) {
      skip(line, t('Eine Weiche ohne Bedingung nimmt allen Domains darunter den Verkehr. Das kennt HAPM nicht.'));
      catchAll ??= line;
      continue;
    }
    const groups = parseCondition(cond, acls);
    const domains = hostDomains(groups.flat());
    if (domains.length === 0) {
      const other = groups.flat().find((term) => term.meaning.kind === 'other');
      skip(
        line,
        other?.meaning.kind === 'other'
          ? t('{reason} Die Weiche kann damit jede Domain treffen.', { reason: other.meaning.reason })
          : t('Die Weiche hängt an keiner Domain und gälte für alle. Das kennt HAPM nicht.')
      );
      catchAll ??= line;
      continue;
    }
    if (unless) {
      const reason = t('Eine Weiche mit „unless" kennt HAPM nicht.');
      skip(line, reason);
      taint(domains, line, reason);
      continue;
    }

    for (const group of groups) {
      const hosts = group.filter((term) => term.meaning.kind === 'host' && !term.negated);
      const paths = group.filter((term) => term.meaning.kind === 'path' && !term.negated);
      const rest = group.filter((term) => !hosts.includes(term) && !paths.includes(term));
      const groupDomains = hostDomains(hosts);

      if (rest.length > 0 || hosts.length !== 1 || paths.length > 1) {
        const why =
          rest.find((term) => term.meaning.kind === 'other')?.meaning as Extract<Meaning, { kind: 'other' }> | undefined;
        const terms = rest.map((term) => `${term.negated ? '!' : ''}${term.label}`).join(' ');
        const reason =
          rest.length > 0
            ? why
              ? t('Die Weiche hängt außer an der Domain an {terms} ({reason}).', { terms, reason: why.reason })
              : t('Die Weiche hängt außer an der Domain an {terms}.', { terms })
            : hosts.length !== 1
              ? t('Die Weiche verlangt zwei Domain-Bedingungen zugleich.')
              : t('Die Weiche verlangt zwei Pfad-Bedingungen zugleich.');
        skip(line, reason);
        if (groupDomains.length === 0) catchAll ??= line;
        taint(groupDomains.length > 0 ? groupDomains : domains, line, reason);
        continue;
      }

      const pathTerm = paths[0]?.meaning as Extract<Meaning, { kind: 'path' }> | undefined;
      for (const domain of groupDomains) {
        const route = routeOf(domain, line.no);
        if (catchAll) {
          route.problems.push(
            t(
              'Zeile {line} steht davor und kann auch diese Domain treffen. HAPM übernimmt sie nicht, ohne sie ginge ein Teil des Verkehrs woanders hin als bisher.',
              { line: catchAll.no }
            )
          );
        }
        // Eine Domain, die eine frühere Wildcard schon bedient: in HAPM stünde
        // sie davor und käme zum Zug, vorher kam sie es nicht.
        // Auch eine Wildcard, die bisher nur Pfad-Regeln hat, greift vorher.
        const shadow = [...local.entries()].find(
          ([other, r]) => other !== domain && (r.main || r.redirect || r.paths.length > 0) && shadows(other, domain)
        );
        if (shadow && !route.main) {
          route.problems.push(
            t(
              'Zeile {line}: {domain} (Zeile {earlier}) greift vorher. In HAPM käme diese Domain zuerst zum Zug, das änderte, wohin ihr Verkehr geht.',
              { line: line.no, domain: shadow[0], earlier: String(shadow[1].main?.line ?? shadow[1].redirect?.line ?? shadow[1].line) }
            )
          );
        }
        if (route.redirect) {
          skip(
            line,
            t('{domain} wird schon in Zeile {line} weitergeleitet. Diese Weiche kam nie zum Zug.', {
              domain,
              line: route.redirect.line,
            })
          );
          continue;
        }
        if (route.main) {
          skip(
            line,
            t('{domain} geht schon in Zeile {line} an {backend}. Diese Weiche kam nie zum Zug.', {
              domain,
              line: route.main.line,
              backend: route.main.backend,
            })
          );
          continue;
        }
        if (pathTerm) {
          if (route.paths.some((p) => p.paths.join(' ') === pathTerm.paths.join(' '))) {
            skip(
              line,
              t('Die Pfade {paths} hat {domain} schon weiter oben. Diese Weiche kam nie zum Zug.', {
                paths: pathTerm.paths.join(' '),
                domain,
              })
            );
            continue;
          }
          route.paths.push({ paths: pathTerm.paths, backend, line: line.no });
        } else {
          route.main = { backend, line: line.no };
        }
        route.notes.push(...hosts.flatMap((term) => (term.meaning.kind === 'host' ? term.meaning.notes : [])));
      }
    }
  }

  /* Alles andere mit Wirkung: eine Regel für eine Domain gehört zu deren
   * Eintrag und macht ihn unvollständig, eine ohne Domain gilt für alle. */
  for (const line of others) {
    const kw = line.words[0].toLowerCase();
    if (/^(http-request|http-response|http-after-response|tcp-request|tcp-response)$/.test(kw)) {
      const lua = /lua\./.test(line.text) || line.words.includes('use-service');
      const { cond } = splitRule(line.words.slice(1));
      const domains = cond ? hostDomains(parseCondition(cond, acls).flat()) : [];
      if (domains.length > 0) {
        const reason = lua
          ? t('Eine Lua-Aktion für diese Domain übernimmt HAPM nicht.')
          : t('Die Regel „{rule}" für diese Domain bildet HAPM nicht ab.', { rule: line.words.slice(0, 2).join(' ') });
        skip(line, reason);
        taint(domains, line, reason);
      } else {
        skip(
          line,
          lua
            ? t('Lua-Aktionen übernimmt HAPM nicht.')
            : t('Die Regel gilt für alle Domains des Frontends. Was für alle gelten soll, steht in HAPM unter Reverse-Proxy, Einstellungen.')
        );
        // Eine Regel, die Besucher abweist (nur aus dem Büro, nur mit Passwort),
        // fiele beim Import weg, und die Domain wäre danach für jeden offen.
        // Das ist kein Hinweis am Rand, sondern ein Grund, sie nicht zu übernehmen.
        if (ACCESS_ACTIONS.test(line.words.slice(1, 4).join(' '))) {
          frontendWide.push({
            line,
            reason: t(
              'Die Regel „{rule}“ beschränkt den Zugriff für alle Domains dieses Frontends. HAPM übernimmt sie nicht, importiert wäre die Domain für jeden erreichbar. Erst unter Reverse-Proxy, Einstellungen den Zugriffsschutz einrichten oder die Sperre am Ziel setzen.',
              { rule: line.words.slice(0, 2).join(' ') }
            ),
          });
        }
      }
      continue;
    }
    if (kw === 'use-server' || kw === 'stick' || kw === 'stick-table') {
      skip(line, t('Bindungen und Tabellen im Frontend bildet HAPM nicht ab.'));
      continue;
    }
    skip(line, t('„{line}" bildet HAPM nicht ab.', { line: line.text }));
  }

  if (defaultBackend) {
    const name = defaultBackend.words[1] ?? '';
    ctx.usedBackends.add(name);
    skip(
      defaultBackend,
      t('Was keine Weiche trifft, ging an {backend}. In HAPM antwortet an dieser Stelle die Seite für unbekannte Domains.', {
        backend: name,
      })
    );
  }
  if (section.kind === 'listen' && section.body.some((l) => l.words[0].toLowerCase() === 'server')) {
    skip(section.head, t('Die Ziele dieses listen-Abschnitts bekommen alles, was keine Weiche trifft. Das kennt HAPM nicht.'));
  }

  /* Was dieses Frontend über seine Domains sagt, mit dem zusammenlegen, was
   * andere Frontends sagen. HTTP und HTTPS stehen oft getrennt da und routen
   * dieselbe Domain gleich; routen sie sie verschieden, ist das ein Grund. */
  const tls = binds.some((b) => b.ssl);
  const ports = unique(binds.filter((b) => !b.quic).map((b) => b.port).filter((p): p is number => p !== null));
  // Ein abgeschaltetes Frontend bedient niemanden. Importiert liefe die Domain.
  const disabled = settings.find((line) => line.words[0].toLowerCase() === 'disabled');
  if (disabled) {
    frontendWide.push({ line: disabled, reason: t('Das Frontend ist abgeschaltet (disabled). Importiert liefe die Domain.') });
  }
  for (const [domain, route] of local) {
    if (!route.main && !route.redirect && route.paths.length === 0 && route.problems.length === 0) continue;
    for (const wide of frontendWide) {
      route.problems.push(t('Zeile {line}: {reason}', { line: wide.line.no, reason: wide.reason }));
    }
    if (!route.main && !route.redirect && route.paths.length > 0) {
      route.problems.push(
        t('{domain} hat nur Pfad-Regeln und keine Weiche für den Rest. HAPM braucht für jede Domain ein Ziel.', { domain })
      );
    }
    const unusual = ports.filter((p) => p !== 80 && p !== 443);
    if (!tls) {
      route.notes.push(noTlsNote(label));
    } else if (unusual.length > 0) {
      route.notes.push(t('Lief bisher auf Port {ports}. In HAPM läuft es auf 443.', { ports: unusual.join(', ') }));
    }
    if (section.modeAssumed) {
      route.notes.push(
        t('{section} nennt keinen mode, auch nicht über defaults. Weil er HTTP benutzt, gilt er als mode http.', {
          section: label,
        })
      );
    }
    route.sources.push(label);

    const previous = ctx.routes.get(domain);
    if (!previous) {
      ctx.routes.set(domain, route);
      continue;
    }
    if (routeSignature(previous) !== routeSignature(route)) {
      previous.problems.push(
        t('{domain} geht in {sources} woanders hin als in {section}. HAPM kennt einen Weg je Domain.', {
          domain,
          sources: previous.sources.join(', '),
          section: label,
        })
      );
    }
    previous.problems.push(...route.problems);
    previous.notes.push(...route.notes.filter((n) => !isNoTlsNote(n)));
    // Über HTTPS schon erreichbar: dann ist die Fassung ohne TLS die Umleitung
    // davor und nicht der Weg, auf dem die Domain lief.
    if (tls) previous.notes = previous.notes.filter((n) => !isNoTlsNote(n));
    previous.sources.push(label);
  }
}

function routeSignature(route: DomainRoute): string {
  return JSON.stringify({
    main: route.main?.backend ?? null,
    redirect: route.redirect?.target ?? null,
    paths: route.paths.map((p) => [p.paths, p.backend]),
  });
}

/* ── Aus einem Weg wird ein Eintrag ── */

function routeName(backend: string, taken: Set<string>): string {
  const base =
    backend.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'pfad';
  let name = /^[a-z0-9]/.test(base) ? base : `p${base}`;
  for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
  taken.add(name);
  return name;
}

function sameHeaders(a: HeaderRule[], b: HeaderRule[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Ob geprüft wird, und wie HAPM es abbildet. HAPM kennt am Hauptziel genau
 * eine Prüfung: `option httpchk` mit GET / und dem Host-Header der
 * Hauptdomain, und `check` auf jeder server-Zeile.
 */
function healthcheckOf(
  read: ProxyRead,
  domains: string[],
  problems: string[],
  notes: string[]
): boolean {
  const checks = read.servers.filter((s) => s.check).length;
  if (checks > 0 && checks < read.servers.length) {
    problems.push(t('Nur ein Teil der Ziele wird geprüft. HAPM prüft alle oder keins.'));
    return false;
  }
  const all = checks > 0;
  if (read.httpchk && all) {
    if (!healthcheckPossible(domains)) {
      if (read.servers.length > 1) {
        problems.push(t('Der Healthcheck braucht eine Domain ohne Stern. Ohne ihn verteilte HAProxy auch auf tote Ziele.'));
      } else {
        notes.push(t('Der Healthcheck entfällt: er braucht eine Domain ohne Stern.'));
      }
      return false;
    }
    notes.push(
      t('Healthcheck an. Bisher: „{line}". HAPM prüft GET / mit dem Host-Header {domain} und erwartet 200 bis 399.', {
        line: read.httpchk,
        domain: domains[0],
      })
    );
    return true;
  }
  if (all) {
    if (read.servers.length > 1) {
      problems.push(
        t('Die Ziele werden über die Verbindung geprüft (check ohne option httpchk). HAPM kennt am Hauptziel nur die HTTP-Prüfung.')
      );
    } else {
      notes.push(t('Die Verbindungsprüfung entfällt. Bei einem einzigen Ziel ändert das nichts daran, wohin der Verkehr geht.'));
    }
  }
  return false;
}

function stickyOf(read: ProxyRead, problems: string[], notes: string[]): boolean {
  const marked = read.servers.filter((s) => s.cookie !== null);
  if (!read.cookie) {
    if (marked.length > 0) problems.push(t('Cookie-Marken auf den server-Zeilen ohne cookie-Zeile im Backend.'));
    return false;
  }
  const allowed = new Set(['insert', 'indirect', 'nocache', 'httponly', 'secure']);
  if (!read.cookie.options.includes('insert')) {
    problems.push(
      t('cookie {name} {options}: HAPM kennt nur einen Cookie, den HAProxy selbst setzt (insert).', {
        name: read.cookie.name,
        options: read.cookie.options.join(' '),
      })
    );
    return false;
  }
  const foreign = read.cookie.options.filter((o) => !allowed.has(o));
  if (foreign.length > 0) {
    problems.push(t('Die Angaben {options} am Cookie kennt HAPM nicht.', { options: foreign.join(' ') }));
    return false;
  }
  if (marked.length !== read.servers.length) {
    problems.push(t('Die Sitzungsbindung steht nicht auf jeder server-Zeile.'));
    return false;
  }
  if (read.cookie.name !== STICKY_COOKIE || marked.some((s) => s.cookie !== s.name)) {
    notes.push(
      t(
        'Die Sitzungsbindung heißt in HAPM {cookie} und trägt den Servernamen. Bestehende Bindungen gehen beim ersten Aufruf einmal verloren.',
        { cookie: STICKY_COOKIE }
      )
    );
  }
  return true;
}

/** Eine Art für alle Ziele eines Backends: HAPM schreibt sie auf jede Zeile. */
function backendTlsOf(read: ProxyRead, problems: string[], where?: string): BackendTls {
  const modes = unique(read.servers.map((s) => s.tls));
  if (modes.length > 1) {
    const reason = t('Die Ziele sprechen teils HTTP, teils HTTPS. HAPM kennt eine Art je Backend.');
    problems.push(where ? `${where}: ${reason}` : reason);
  }
  return modes[0] ?? 'off';
}

const TLS_LABELS: Record<Exclude<BackendTls, 'off'>, string> = {
  insecure: msgid('HTTPS zum Ziel'),
  verify: msgid('HTTPS zum Ziel, Zertifikat geprüft'),
};

function emptyService(domains: string[]): CreateServiceInput {
  return {
    scope: '',
    id: '',
    domains,
    servers: [],
    redirect: null,
    routes: [],
    balance: null,
    sticky: false,
    lockedDomains: [],
    passwordLock: null,
    responseHeaders: [],
    requestHeaders: [],
    tunnel: false,
    crowdsec: false,
    app: null,
    healthcheck: false,
    backendTls: 'off',
  };
}

function httpEntry(
  domains: string[],
  route: DomainRoute,
  backendOf: (name: string) => { section: Section; read: ProxyRead } | null
): ImportEntry {
  const problems = [...route.problems];
  const notes = unique(route.notes);
  const service = emptyService(domains);
  const sourceParts = [...unique(route.sources)];

  if (route.redirect) {
    service.redirect = route.redirect.target;
  } else if (route.main) {
    sourceParts.push(`backend ${route.main.backend}`);
    const found = backendOf(route.main.backend);
    if (!found) {
      problems.push(t('Das Backend {backend} steht nicht in der Datei.', { backend: route.main.backend }));
    } else {
      const { section, read } = found;
      if (section.mode !== 'http') {
        problems.push(
          t('Das Backend {backend} läuft in mode {mode} hinter einem HTTP-Frontend.', {
            backend: route.main.backend,
            mode: section.mode,
          })
        );
      }
      problems.push(...read.problems);
      notes.push(...read.notes);
      if (read.redirect) {
        if (read.servers.length > 0) problems.push(t('Das Backend leitet weiter und hat zugleich Ziele.'));
        if (read.balance || read.cookie || read.httpchk || read.tunnel || read.requestHeaders.length || read.responseHeaders.length) {
          problems.push(t('Das Backend leitet weiter und trägt daneben Einstellungen für Ziele.'));
        }
        service.redirect = read.redirect;
      } else {
        if (read.servers.length === 0 && read.problems.length === 0) {
          problems.push(t('Das Backend {backend} hat kein Ziel.', { backend: route.main.backend }));
        }
        if (read.balance !== null && !(HAPROXY_BALANCE as readonly string[]).includes(read.balance)) {
          problems.push(t('Das Verfahren balance {balance} kennt HAPM nicht.', { balance: read.balance }));
        }
        service.servers = read.servers.map((s) => ({ name: s.name, target: s.target, weight: s.weight }));
        service.balance = (HAPROXY_BALANCE as readonly string[]).includes(read.balance ?? '')
          ? (read.balance as HaproxyBalance)
          : null;
        service.sticky = stickyOf(read, problems, notes);
        service.healthcheck = healthcheckOf(read, domains, problems, notes);
        service.requestHeaders = read.requestHeaders;
        service.responseHeaders = read.responseHeaders;
        service.tunnel = read.tunnel;
        service.backendTls = backendTlsOf(read, problems);
      }
    }
  }

  const names = new Set<string>();
  for (const path of route.paths) {
    sourceParts.push(`backend ${path.backend}`);
    const found = backendOf(path.backend);
    if (!found) {
      problems.push(t('Das Backend {backend} steht nicht in der Datei.', { backend: path.backend }));
      continue;
    }
    const { read } = found;
    const where = t('Pfad-Regel {paths} (backend {backend})', { paths: path.paths.join(' '), backend: path.backend });
    problems.push(...read.problems.map((p) => `${where}: ${p}`));
    notes.push(...read.notes);
    if (read.redirect) problems.push(t('{rule}: eine Weiterleitung als Pfad-Regel kennt HAPM nicht.', { rule: where }));
    if (read.servers.length === 0) problems.push(t('{rule}: kein Ziel.', { rule: where }));
    if (read.balance) problems.push(t('{rule}: ein Verfahren an einer Pfad-Regel kennt HAPM nicht.', { rule: where }));
    if (read.cookie) problems.push(t('{rule}: eine Sitzungsbindung an einer Pfad-Regel kennt HAPM nicht.', { rule: where }));
    if (read.httpchk) {
      problems.push(t('{rule}: eine HTTP-Prüfung an einer Pfad-Regel kennt HAPM nicht, nur check.', { rule: where }));
    }
    if (read.servers.some((s) => s.weight !== null)) {
      problems.push(t('{rule}: eine Gewichtung an einer Pfad-Regel kennt HAPM nicht.', { rule: where }));
    }
    const checks = read.servers.filter((s) => s.check).length;
    if (checks > 0 && checks < read.servers.length) {
      problems.push(t('{rule}: nur ein Teil der Ziele wird geprüft.', { rule: where }));
    }
    // HAPM schreibt die Zusätze in JEDES Backend des Eintrags.
    if (
      read.tunnel !== service.tunnel ||
      !sameHeaders(read.requestHeaders, service.requestHeaders) ||
      !sameHeaders(read.responseHeaders, service.responseHeaders)
    ) {
      problems.push(
        t('{rule}: Header und lange Verbindungen stehen dort anders als am Hauptziel. HAPM setzt sie für alle gleich.', {
          rule: where,
        })
      );
    }
    // `coolify_terminal` neben `coolify` heißt in HAPM `terminal`: der Name der
    // Regel steht ohnehin hinter der Kennung des Eintrags.
    const main = route.main?.backend;
    const short =
      main && path.backend.length > main.length + 1 && /^[_-]$/.test(path.backend[main.length]) &&
      path.backend.startsWith(main)
        ? path.backend.slice(main.length + 1)
        : path.backend;
    const routeInput: RouteInput = {
      name: routeName(short, names),
      paths: path.paths,
      servers: read.servers.map((s) => ({ name: s.name, target: s.target })),
      check: checks > 0 && checks === read.servers.length,
      backendTls: backendTlsOf(read, problems, where),
    };
    service.routes.push(routeInput);
  }

  if (service.redirect && service.routes.length > 0) {
    problems.push(t('Eine Weiterleitung mit Pfad-Regeln kennt HAPM nicht.'));
  }

  if (problems.length === 0) {
    const invalid = validateNewService({ ...service, scope: 'IMPORT' });
    if (invalid) problems.push(t(invalid));
  }

  const kind: ImportKind = serviceKind(service);
  return {
    key: `http:${domains.join(',')}`,
    kind,
    source: unique(sourceParts).join(' → '),
    line: route.line,
    domains,
    port: null,
    targets: service.redirect
      ? [`→ ${service.redirect.to}`]
      : [
          ...service.servers.map((s) => (s.weight === null ? s.target : t('{target} (Gewicht {weight})', { target: s.target, weight: s.weight }))),
          ...service.routes.map((r) => `${r.paths.join(' ')} → ${r.servers.map((s) => s.target).join(', ')}`),
        ],
    extras: [
      ...(service.redirect
        ? [
            t(service.redirect.keepPath ? '{code}, mit Pfad' : '{code}, ohne Pfad', {
              code: service.redirect.permanent ? '301' : '302',
            }),
          ]
        : []),
      ...(service.balance ? [`balance ${service.balance}`] : []),
      ...(service.sticky ? [t('Sitzungsbindung')] : []),
      ...(service.healthcheck ? [t('Healthcheck')] : []),
      ...service.requestHeaders.map((h) => t('Header an das Ziel: {name}', { name: h.name })),
      ...service.responseHeaders.map((h) => t('Header an den Besucher: {name}', { name: h.name })),
      ...(service.tunnel ? [t('Lange Verbindungen')] : []),
      ...(service.backendTls !== 'off' ? [t(TLS_LABELS[service.backendTls])] : []),
      ...unique(service.routes.filter((r) => r.backendTls !== 'off').map((r) => t(TLS_LABELS[r.backendTls as Exclude<BackendTls, 'off'>]))).map(
        (label) => t('Pfad-Regel: {what}', { what: label })
      ),
    ],
    notes: unique(notes),
    problems: unique(problems),
    service: problems.length === 0 ? service : null,
    stream: null,
  };
}

function streamEntry(
  head: Section,
  binds: BindRead[],
  read: ProxyRead,
  extraProblems: string[],
  source: string
): ImportEntry {
  const problems = [...extraProblems, ...read.problems];
  const notes = [...read.notes];

  const ports = unique(binds.map((b) => b.port));
  if (binds.length === 0) problems.push(t('Der Abschnitt hat keine bind-Zeile.'));
  else if (ports.length !== 1 || ports[0] === null) {
    problems.push(t('Der Abschnitt bindet mehrere oder keine lesbaren Ports. HAPM kennt einen je Weiterleitung.'));
  }
  if (binds.some((b) => b.ssl)) {
    problems.push(t('TLS am Port (bind … ssl) kennt HAPM bei einer TCP-Weiterleitung nicht: es reicht durch.'));
  }
  if (binds.some((b) => !b.wildcard)) {
    problems.push(
      t('Der Port ist an eine bestimmte Adresse gebunden. HAPM bindet an alle, der Port stünde danach weiter offen als vorher.')
    );
  }
  const foreign = unique(binds.flatMap((b) => b.params.filter((p) => p !== 'v4v6' && p !== 'v6only' && p !== 'ssl')));
  if (foreign.length > 0) problems.push(t('Die Angaben {options} an bind kennt HAPM nicht.', { options: foreign.join(' ') }));
  if (binds.some((b) => b.ipv6)) {
    notes.push(t('HAPM bindet den Port mit „bind :Port" wie jede TCP-Weiterleitung, ohne eigene IPv6-Zeile.'));
  }

  if (read.servers.length === 0) problems.push(t('Die Weiterleitung hat kein Ziel.'));
  if (read.balance !== null && !(STREAM_BALANCE as readonly string[]).includes(read.balance)) {
    problems.push(t('Das Verfahren balance {balance} kennt HAPM in mode tcp nicht.', { balance: read.balance }));
  }
  const checks = read.servers.filter((s) => s.check).length;
  if (checks > 0 && checks < read.servers.length) problems.push(t('Nur ein Teil der Ziele wird geprüft. HAPM prüft alle oder keins.'));
  if (read.servers.some((s) => s.cookie !== null)) problems.push(t('Eine Cookie-Marke gibt es in mode tcp nicht.'));
  if (read.servers.some((s) => s.tls !== 'off')) {
    problems.push(t('ssl an einer server-Zeile kennt HAPM bei einer TCP-Weiterleitung nicht: sie reicht durch, was kommt.'));
  }

  const port = ports.length === 1 ? ports[0] : null;
  const stream: CreateStreamInput = {
    scope: '',
    id: '',
    port: port ?? 0,
    servers: read.servers.map((s) => ({ name: s.name, target: s.target, weight: s.weight })),
    balance: (STREAM_BALANCE as readonly string[]).includes(read.balance ?? '')
      ? (read.balance as StreamBalance)
      : null,
    check: checks > 0 && checks === read.servers.length,
    allowedSources: read.sources,
  };
  if (problems.length === 0) {
    const invalid = validateNewStream({ ...stream, scope: 'IMPORT' });
    if (invalid) problems.push(t(invalid));
  }

  return {
    key: `tcp:${port ?? head.name ?? head.head.no}`,
    kind: 'tcp',
    source,
    line: head.head.no,
    domains: [],
    port,
    targets: read.servers.map((s) => (s.weight === null ? s.target : t('{target} (Gewicht {weight})', { target: s.target, weight: s.weight }))),
    extras: [
      ...(stream.balance ? [`balance ${stream.balance}`] : []),
      ...(stream.check ? [t('Verbindungsprüfung')] : []),
      stream.allowedSources.length > 0
        ? t('nur von {sources}', { sources: stream.allowedSources.join(', ') })
        : t('offen für alle'),
    ],
    notes: unique(notes),
    problems: unique(problems),
    service: null,
    stream: problems.length === 0 ? stream : null,
  };
}

/* ── Der ganze Text ── */

/** Deutsche Schlüssel (`msgid`), übersetzt beim Einsetzen. */
const SECTION_REASONS: Record<string, string> = {
  global: msgid('Globale Einstellungen übernimmt HAPM nicht: es bringt eigene mit (Prozess, Log, Statistik, TLS-Vorgaben).'),
  defaults: msgid('Die Vorgaben (Timeouts, Log, Fehlerseiten) übernimmt HAPM nicht: es bringt eigene mit.'),
  userlist: msgid(
    'Benutzerlisten für Basic-Auth kennt HAPM nicht. Für einen Zugang mit Passwort gibt es am Eintrag die Passwortsperre.'
  ),
};

/**
 * Den Text lesen. Gründe und Hinweise stehen in der Sprache von `translator`,
 * ohne ihn auf Deutsch (so, wie ein Lauf sie speichert).
 */
export function parseImport(text: string, translator?: Translate): ImportResult {
  return withTranslator(translator, () => readImport(text));
}

function readImport(text: string): ImportResult {
  const skipped: SkippedLine[] = [];
  const sections = readSections(readLines(text), skipped);
  const entries: ImportEntry[] = [];

  const proxies = new Map<string, Section>();
  for (const section of sections) {
    if (section.name && ['backend', 'listen', 'frontend'].includes(section.kind)) proxies.set(section.name, section);
  }
  const backendNames = new Set(
    sections.filter((s) => s.kind === 'backend' || s.kind === 'listen').map((s) => s.name ?? '')
  );
  const global: GlobalRead = {
    serverVerifyNone: sections.some(
      (s) =>
        s.kind === 'global' &&
        s.body.some((l) => l.words[0].toLowerCase() === 'ssl-server-verify' && l.words[1]?.toLowerCase() === 'none')
    ),
  };
  const reads = new Map<string, ProxyRead>();
  const backendOf = (name: string) => {
    const section = proxies.get(name);
    if (!section || section.kind === 'frontend') return null;
    if (!reads.has(name)) reads.set(name, readProxyBody(section, global));
    return { section, read: reads.get(name)! };
  };

  const ctx: FrontendContext = { routes: new Map(), skipped, usedBackends: new Set(), backendNames };

  for (const section of sections) {
    const range =
      section.body.length > 0
        ? t('{line} (Zeile {from} bis {to})', {
            line: section.head.text,
            from: section.head.no,
            to: section.body[section.body.length - 1].no,
          })
        : t('{line} (Zeile {from})', { line: section.head.text, from: section.head.no });
    if (section.kind === 'global') {
      skipped.push({ line: section.head.no, text: range, reason: t(SECTION_REASONS.global) });
      for (const line of section.body) {
        if (/^lua-/.test(line.words[0])) {
          skipped.push({ line: line.no, text: line.text, reason: t('Lua-Skripte übernimmt HAPM nicht.') });
        }
      }
      continue;
    }
    if (!['frontend', 'backend', 'listen'].includes(section.kind)) {
      skipped.push({
        line: section.head.no,
        text: range,
        reason: SECTION_REASONS[section.kind]
          ? t(SECTION_REASONS[section.kind])
          : t('Abschnitte der Art {kind} kennt HAPM nicht.', { kind: section.kind }),
      });
      continue;
    }
    if (section.kind === 'backend') continue;

    if (section.mode === 'http') {
      readHttpFrontend(section, ctx);
      continue;
    }
    if (section.mode !== 'tcp') {
      skipped.push({ line: section.head.no, text: range, reason: t('mode {mode} kennt HAPM nicht.', { mode: section.mode }) });
      continue;
    }

    /* TCP: ein `listen` mit eigenen Zielen, oder ein `frontend` mit
     * `default_backend`. Weichen (meist nach SNI) heißen, dass der Port je
     * nach Name woanders hingeht: das ist Durchreichen von TLS nach Namen,
     * und das kennt HAPM nicht. */
    const label = `${section.kind} ${section.name ?? ''}`.trim();
    if (section.kind === 'listen') {
      const read = readProxyBody(section, global);
      if (read.servers.length === 0 && read.problems.length > 0 && read.binds.length === 0) {
        skipped.push({ line: section.head.no, text: range, reason: read.problems.join(' ') });
        continue;
      }
      entries.push(streamEntry(section, read.binds, read, [], label));
      continue;
    }
    const own = readProxyBody({
      ...section,
      body: section.body.filter((l) => !['default_backend', 'use_backend'].includes(l.words[0].toLowerCase())),
    });
    const extra: string[] = [];
    if (section.body.some((l) => l.words[0].toLowerCase() === 'use_backend')) {
      extra.push(t('Weichen in mode tcp (etwa nach SNI, TLS wird durchgereicht) kennt HAPM nicht.'));
    }
    const defaultLine = section.body.find((l) => l.words[0].toLowerCase() === 'default_backend');
    const backendName = defaultLine?.words[1] ?? '';
    ctx.usedBackends.add(backendName);
    for (const l of section.body.filter((x) => x.words[0].toLowerCase() === 'use_backend')) {
      ctx.usedBackends.add(splitRule(l.words.slice(1)).action[0] ?? '');
    }
    const target = defaultLine ? backendOf(backendName) : null;
    if (!defaultLine) extra.push(t('Das Frontend hat kein default_backend.'));
    else if (!target) extra.push(t('Das Backend {backend} steht nicht in der Datei.', { backend: backendName }));
    else if (target.section.mode !== 'tcp') {
      extra.push(t('Das Backend {backend} läuft nicht in mode tcp.', { backend: backendName }));
    }
    // Die Ziele kommen aus dem Backend, Port und Absender aus dem Frontend.
    if (own.servers.length > 0) extra.push(t('Das Frontend trägt eigene server-Zeilen.'));
    const read: ProxyRead = {
      ...(target?.read ?? own),
      problems: [...own.problems, ...(target?.read.problems ?? [])],
      sources: own.sources,
      sourceRules: own.sourceRules,
      notes: [...own.notes, ...(target?.read.notes ?? [])],
    };
    if (target && target.read.sources.length > 0) {
      extra.push(t('Die Absenderliste steht im Backend. HAPM erwartet sie am Port.'));
    }
    entries.push(streamEntry(section, own.binds, read, extra, `${label} → backend ${backendName}`));
  }

  /* Die Domains: wer denselben Weg hat, wird ein Eintrag. */
  const groups = new Map<string, { domains: string[]; route: DomainRoute }>();
  for (const [domain, route] of ctx.routes) {
    const key = `${routeSignature(route)}|${route.problems.length > 0 ? 'x' : ''}`;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { domains: [domain], route: { ...route, problems: [...route.problems], notes: [...route.notes], sources: [...route.sources] } });
      continue;
    }
    group.domains.push(domain);
    group.route.problems.push(...route.problems);
    group.route.notes.push(...route.notes);
    group.route.sources.push(...route.sources);
    group.route.line = Math.min(group.route.line, route.line);
  }
  for (const { domains, route } of groups.values()) {
    entries.push(httpEntry(orderDomains(domains), route, backendOf));
  }

  /* Backends, auf die nichts zeigt: sie gehen nirgends hin mit. */
  for (const section of sections) {
    if (section.kind !== 'backend' || !section.name || ctx.usedBackends.has(section.name)) continue;
    const range = t('{line} (Zeile {from})', { line: section.head.text, from: section.head.no });
    skipped.push({
      line: section.head.no,
      text: range,
      reason: t('Auf dieses Backend zeigt keine Weiche. Es wird nicht übernommen.'),
    });
  }

  /* Zwei Einträge mit demselben Schlüssel (zweimal derselbe Port): der
   * zweite käme nie zum Zug. */
  const seen = new Map<string, ImportEntry>();
  for (const entry of entries) {
    const first = seen.get(entry.key);
    if (!first) {
      seen.set(entry.key, entry);
      continue;
    }
    let n = 2;
    while (seen.has(`${entry.key}#${n}`)) n++;
    entry.key = `${entry.key}#${n}`;
    seen.set(entry.key, entry);
    if (entry.kind === 'tcp' && entry.port !== null) {
      entry.problems.push(t('Port {port} steht schon in Zeile {line}.', { port: entry.port, line: first.line }));
      entry.stream = null;
    }
  }

  entries.sort((a, b) => a.line - b.line);
  skipped.sort((a, b) => a.line - b.line);
  return { entries, skipped };
}

/* ── Gegen den Stand von HAPM ── */

/** übernehmbar · Konflikt mit etwas, das es in HAPM schon gibt · hier nicht
 *  möglich (Zugangsdaten, acme.sh) · nicht übernehmbar. */
export type ImportState = 'ready' | 'conflict' | 'blocked' | 'unsupported';

export interface AssessedEntry extends ImportEntry {
  state: ImportState;
  reason: string | null;
  /** Die Kennung, die der Eintrag beim Anlegen voraussichtlich bekommt. Fest
   *  wird sie erst im Lauf: dazwischen kann jemand anders eine vergeben. */
  id: string | null;
}

export interface ImportEnvironment {
  /** Die `haproxy.cfg`, wie sie jetzt auf der Maschine steht. */
  config: string;
  exposure: Exposure;
  dnsHooks: string[];
  dnsHook: string | null;
  /** Aus den Einstellungen. Fehlt es, gilt das Verhalten davor: acme.sh, HTTP-01 nur öffentlich. */
  source?: CertificateSource;
  httpReachable?: boolean;
  /** Was schon ausgestellt oder hochgeladen ist. Ein Eintrag, den eins davon abdeckt, braucht keinen Antrag. */
  certificates?: AcmeCertificate[];
  acmeReady: boolean;
  /** Ports, auf denen auf der Maschine schon etwas lauscht, mit Grund. */
  busyPorts: Record<number, string>;
}

/** Gegen den Stand von HAPM. Die Gründe stehen in der Sprache von `translator`, ohne ihn auf Deutsch. */
export function assessImport(
  entries: ImportEntry[],
  env: ImportEnvironment,
  translator?: Translate
): AssessedEntry[] {
  return withTranslator(translator, () => assessEntries(entries, env));
}

function assessEntries(entries: ImportEntry[], env: ImportEnvironment): AssessedEntry[] {
  const services = parseHaproxyConfig(env.config);
  const taken: string[] = [];

  return entries.map((entry): AssessedEntry => {
    if (entry.problems.length > 0 || (!entry.service && !entry.stream)) {
      return { ...entry, state: 'unsupported', reason: entry.problems[0] ?? null, id: null };
    }
    if (entry.service) {
      const conflict = findDomainConflict(services, entry.service.domains);
      if (conflict) {
        return {
          ...entry,
          state: 'conflict',
          reason: t('Die Domain {domain} wird in HAPM schon von „{service}" bedient.', {
            domain: conflict.domain,
            service: conflict.service.id,
          }),
          id: null,
        };
      }
      const covered = findCertificateFor(env.certificates ?? [], entry.service.domains) !== null;
      const source = env.source ?? 'acme';
      if (!covered && !env.acmeReady && source === 'acme') {
        return {
          ...entry,
          state: 'blocked',
          reason: t('acme.sh fehlt. Ohne lässt sich kein Zertifikat ausstellen. Der Zustand steht in der Übersicht.'),
          id: null,
        };
      }
      const plan = planChallenge(
        entry.service.domains,
        {
          exposure: env.exposure,
          dnsHook: env.dnsHook,
          source,
          // Für die Regel unerheblich, ausgestellt wird erst im Lauf.
          acmeServer: '',
          httpReachable: env.httpReachable ?? false,
        },
        env.dnsHooks
      );
      if (!covered && plan.method === 'unavailable') {
        return { ...entry, state: 'blocked', reason: t(plan.message), id: null };
      }
      const id = assignServiceId(env.config, entry.service, taken);
      taken.push(id);
      return { ...entry, state: 'ready', reason: null, id };
    }

    const stream = entry.stream!;
    const bound = bindConflict(env.config, stream.port);
    if (bound) {
      return {
        ...entry,
        state: 'conflict',
        reason: t('Port {port} ist in HAPM schon gebunden ({section}).', { port: stream.port, section: bound }),
        id: null,
      };
    }
    const busy = env.busyPorts[stream.port];
    if (busy) return { ...entry, state: 'conflict', reason: `Port ${stream.port}: ${busy}`, id: null };
    const id = assignStreamId(env.config, stream.port, taken);
    taken.push(id);
    return { ...entry, state: 'ready', reason: null, id };
  });
}

/** Die Antwort von `/api/haproxy/import/preview`. */
export interface ImportPreview {
  entries: AssessedEntry[];
  skipped: SkippedLine[];
  /** Die vollständigen Gruppen, in die sich importieren lässt. */
  scopes: { name: string; label: string }[];
  suggestedScope: string;
  exposure: Exposure;
  dnsHooks: string[];
  acmeReady: boolean;
}

/* ── Die Gruppe ── */

/** Wie `validateScopeName` (dort stehen auch die Namen der Unterseiten), dazu
 *  die Gruppen, die es schon gibt: im Formular steht dafür die Auswahl. */
export function newScopeError(name: string, existing: Pick<HaproxyScopeInfo, 'name'>[]): Message | null {
  const invalid = validateScopeName(name);
  if (invalid) return invalid;
  if (existing.some((s) => s.name.toUpperCase() === name.trim().toUpperCase())) {
    return msg('Die Gruppe {name} gibt es schon. Wählen Sie sie oben aus.', { name: name.trim() });
  }
  return null;
}

/** `IMPORTIERT` und nicht `IMPORT`: deren Seite läge unter dieser hier. */
export function suggestScopeName(existing: Pick<HaproxyScopeInfo, 'name'>[]): string {
  const names = new Set(existing.map((s) => s.name.toUpperCase()));
  let name = 'IMPORTIERT';
  for (let n = 2; names.has(name); n++) name = `IMPORTIERT_${n}`;
  return name;
}

/* ── Das Kontingent ── */

/** Grob die registrierte Domain: die letzten beiden Teile. Für `co.uk` und
 *  Ähnliches zu grob, für eine Warnung reicht es. */
function registeredDomain(domain: string): string {
  const name = isWildcardDomain(domain) ? domain.slice(2) : domain;
  return name.split('.').slice(-2).join('.');
}

export interface CertificateLoad {
  /** So viele Zertifikate werden höchstens beantragt: eins je Eintrag mit
   *  Domain. Liegt schon eins, das passt, wird keins beantragt. */
  certificates: number;
  /** Die Domain mit den meisten neuen Zertifikaten. */
  busiest: { domain: string; count: number } | null;
  /** Mindestens eine Grenze wird erreicht. */
  exceeds: boolean;
  /** Mindestens eine Grenze ist zur Hälfte erreicht. */
  near: boolean;
}

export function certificateLoad(entries: { domains: string[] }[]): CertificateLoad {
  const withDomains = entries.filter((e) => e.domains.length > 0);
  const counts = new Map<string, number>();
  for (const entry of withDomains) {
    const base = registeredDomain(entry.domains[0]);
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  const busiest = [...counts].sort((a, b) => b[1] - a[1])[0];
  const top = busiest ? busiest[1] : 0;
  return {
    certificates: withDomains.length,
    busiest: busiest ? { domain: busiest[0], count: busiest[1] } : null,
    exceeds: top > LE_CERTS_PER_DOMAIN_WEEK || withDomains.length > LE_ORDERS_PER_3H,
    near: top >= LE_CERTS_PER_DOMAIN_WEEK / 2 || withDomains.length >= LE_ORDERS_PER_3H / 2,
  };
}
