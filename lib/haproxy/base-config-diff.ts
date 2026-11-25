/**
 * Der Abgleich einer bestehenden `haproxy.cfg` mit der Grundkonfiguration.
 *
 * `base-config.ts` schreibt die Grundkonfiguration genau einmal, wenn die Datei
 * fehlt. Wer HAPM länger betreibt, bekommt neue Vorgaben deshalb nie
 * (Beispiel: `limited-quic`). Dieses Modul sagt, wo die Datei von dem abweicht,
 * was `renderBaseConfig` mit den Optionen dieser Installation ergäbe, und
 * schreibt einzelne Abweichungen auf Wunsch hinein.
 *
 * ── Was verglichen wird ──
 *
 * Nur, was die Grundkonfiguration besitzt: `global`, `defaults` und die beiden
 * Frontends, und davon nur die Zeilen außerhalb der Marker. Kommentare und
 * Leerzeilen zählen nicht, die Reihenfolge auch nicht. Zwei Zeilen sind
 * dieselbe Direktive, wenn ihr Schlüssel gleich ist (`directiveKey`):
 * `timeout client 50s` und `timeout client 30s` sind ein anderer Wert, kein
 * Fehlen und kein Zusatz.
 *
 * ── Was nie vorgeschlagen wird ──
 *
 *  - Was die globalen Einstellungen verwalten (`/reverse-proxy/einstellungen`):
 *    der Block unter `# Globale HTTPS-Settings` und `acl admin_ips`. Zwei
 *    Stellen, die dieselben Zeilen schreiben, widersprächen sich.
 *  - `log` in `global`: `raw` ist Absicht (`lib/haproxy-log.ts`), und wer ein
 *    anderes Ziel eingetragen hat, hat einen Grund.
 *  - Eine vorhandene `errorfile`-Zeile mit anderer Datei: ein 503, der die
 *    Seite der 404 zeigt, ist ein verbreiteter Griff (`error-pages.ts`).
 *  - Alles zwischen `# BEGIN AUTO …` und `# END AUTO …`. Dort stehen auch alte
 *    Kennungen wie `vsm_lock_…`, die nie umbenannt werden.
 *  - Löschen. Eine Zeile, die es nur in der Datei gibt (etwa `daemon`), ist
 *    meist bewusst gesetzt und erscheint nur als Hinweis.
 *
 * ── Wohin eine fehlende Zeile kommt ──
 *
 * Neben ihren Nachbarn aus der Grundkonfiguration: hinter die Zeile, die dort
 * direkt davor steht, sonst vor die direkt danach. Bildet sie in der
 * Grundkonfiguration eine Gruppe für sich (Leerzeile davor und danach), kommt
 * sie mit einer Leerzeile hinter die Gruppe ihres nächsten Vorgängers.
 * Übernommen wird eine Abweichung nach der anderen, und vor jeder wird neu
 * verglichen: so findet die zweite von zwei fehlenden Nachbarzeilen die erste
 * schon an ihrem Platz.
 *
 * Rein: Konfigurationstext rein, Text raus. `tests/haproxy/base-config-diff.test.ts`.
 */

import { msg, msgid } from '../i18n/translate';
import {
  ADMIN_ACL,
  protectionBlockRange,
  HTTPS_MARKER,
  HaproxyConfigError,
  SECTION_KEYWORDS,
  clean,
  httpsBlockRange,
  scopeMarkers,
} from './config';
import { renderBaseConfig, type BaseConfigOptions } from './base-config';

export type BaseConfigDriftKind = 'missing' | 'changed' | 'extra';

export interface BaseConfigDrift {
  /** Stabil, solange sich an der Zeile nichts ändert. Damit wählt die Oberfläche aus. */
  id: string;
  /** Der Kopf des Abschnitts, wie ihn die Grundkonfiguration schreibt (`global`,
   *  `frontend public_https`). */
  section: string;
  kind: BaseConfigDriftKind;
  /** Die Zeile, wie sie in der Datei steht. `null` bei `missing`. */
  current: string | null;
  /** Die Zeile der Grundkonfiguration. `null` bei `extra`. */
  proposed: string | null;
  /** Warum es die Zeile gibt, als Schlüssel für `t()`. `null`, wenn HAPM sie nicht kennt. */
  hint: string | null;
}

export interface BaseConfigDiff {
  /** Mit dieser Option wurde verglichen, abgelesen an der Datei. */
  ipv6: boolean;
  /** Abschnitte der Grundkonfiguration, die es in der Datei nicht gibt. Sie
   *  werden nicht angelegt: wohin, und unter welchem Namen, wäre geraten. */
  missingSections: string[];
  drifts: BaseConfigDrift[];
}

/** Ob die Datei auf IPv6 lauscht. Die Grundkonfiguration schreibt die
 *  IPv6-Zeilen nur, wenn die Maschine IPv6 hat (`bootstrap.ts`), und das steht
 *  danach in der Datei. */
export function detectIpv6(text: string): boolean {
  return text
    .split('\n')
    .some((line) => /^bind\s+(:::|\[::\]|quic6@|ipv6@)/.test(clean(line)));
}

/* ── Der Schlüssel einer Zeile ── */

function normalize(line: string): string {
  return clean(line).replace(/\s+/g, ' ');
}

/** `*:443`, `0.0.0.0:443` und `:443` lauschen auf dasselbe, ebenso `[::]:443`
 *  und `:::443`. Ohne das schlüge der Abgleich eine zweite Zeile auf denselben
 *  Port vor. */
function bindAddress(address: string): string {
  let value = address.replace(/^ipv4@/, '');
  if (value.startsWith('ipv6@')) value = `::${value.slice('ipv6@'.length)}`;
  value = value.replace(/^\*:/, ':').replace(/^0\.0\.0\.0:/, ':').replace(/^\[::\]:/, ':::');
  return value;
}

/**
 * Woran zwei Zeilen als dieselbe Direktive gelten. Bei Wörtern, die mehrfach
 * vorkommen, gehört das Argument dazu, das sie unterscheidet: `timeout client`,
 * `bind :443`, `http-response set-header alt-svc`.
 */
export function directiveKey(line: string): string {
  const text = normalize(line);
  const words = text.split(' ');
  const [first, second = '', third = ''] = words;
  switch (first) {
    case 'timeout':
    case 'stats':
    case 'errorfile':
    case 'acl':
    case 'use_backend':
    case 'option':
      return `${first} ${second}`;
    case 'no':
      return `${first} ${second} ${third}`;
    case 'bind':
      return `bind ${bindAddress(second)}`;
    case 'http-request':
    case 'http-response':
      if (/^(set|add|del)-header$/.test(second)) return `${first} ${second} ${third.toLowerCase()}`;
      if (second === 'redirect') return `${first} ${second} ${third}`;
      return text;
    default:
      return first;
  }
}

/** Der Text, an dem zwei Zeilen als gleich gelten: ohne Unterschiede im
 *  Leerraum, und bei `bind` mit der Adresse in einer Schreibweise. */
function comparable(line: string): string {
  const text = normalize(line);
  const match = /^bind (\S+)(.*)$/.exec(text);
  return match ? `bind ${bindAddress(match[1])}${match[2]}` : text;
}

/** Vorhanden genügt: eine andere Datei hinter `errorfile 503` ist kein Wert,
 *  den HAPM besser weiß. */
const PRESENCE_ONLY = /^errorfile /;

/* ── Begründungen ──
 *
 * Kurz und ohne Wertung: was die Zeile bewirkt. Die Oberfläche zeigt sie hinter
 * dem „i". Was hier fehlt, bekommt keins. */

const HINTS: Record<string, string> = {
  'limited-quic': msgid(
    'Schaltet HTTP/3 auch dann frei, wenn die TLS-Bibliothek von HAProxy keine QUIC-Schnittstelle hat. Ohne die Zeile bleiben die quic-Listener dann aus. Wo die Bibliothek QUIC kann, ist die Zeile wirkungslos.'
  ),
  chroot: msgid('Sperrt HAProxy nach dem Start in dieses Verzeichnis ein. Ein Fehler in HAProxy erreicht den Rest des Dateisystems dann nicht.'),
  'stats socket': msgid('Über diesen Socket liest HAPM, ob die Ziele antworten.'),
  'stats timeout': msgid('Wie lange eine Verbindung zum Socket ohne Befehl offen bleibt.'),
  user: msgid('HAProxy gibt nach dem Start die Rechte von root ab und läuft als dieser Benutzer und diese Gruppe.'),
  group: msgid('HAProxy gibt nach dem Start die Rechte von root ab und läuft als dieser Benutzer und diese Gruppe.'),
  'ca-base': msgid('Verzeichnis für relative Pfade zu CAs und Zertifikaten.'),
  'crt-base': msgid('Verzeichnis für relative Pfade zu CAs und Zertifikaten.'),
  'ssl-default-bind-ciphers': msgid('Verfahren für TLS 1.2: nur solche mit Forward Secrecy und AEAD.'),
  'ssl-default-bind-ciphersuites': msgid('Verfahren für TLS 1.3.'),
  'ssl-default-bind-options': msgid(
    'TLS ab Version 1.2. no-tls-tickets schaltet Sitzungstickets ab, deren Schlüssel sonst über viele Verbindungen gleich bliebe.'
  ),
  log: msgid('Die Abschnitte schreiben in das Log, das in global steht.'),
  mode: msgid('HAProxy liest HTTP. Ohne das gibt es keine Weichen nach Domain, keine Kopfzeilen und keine Sperren.'),
  'option httplog': msgid('Eine ausführliche Logzeile je Anfrage. Logs und Statistik in HAPM lesen dieses Format.'),
  'option dontlognull': msgid('Verbindungen ohne Anfrage, etwa von Port-Scans, kommen nicht ins Log.'),
  'timeout connect': msgid('Wie lange HAProxy auf den Verbindungsaufbau zum Ziel wartet.'),
  'timeout client': msgid('Wie lange eine Verbindung offen bleibt, über die der Besucher nichts schickt.'),
  'timeout server': msgid('Wie lange HAProxy auf eine Antwort des Ziels wartet.'),
  'timeout http-request': msgid('Bis dahin muss eine Anfrage vollständig angekommen sein. Schützt vor Anfragen, die absichtlich langsam tröpfeln.'),
  'timeout http-keep-alive': msgid('Wie lange eine Verbindung zwischen zwei Anfragen offen bleibt.'),
  'timeout queue': msgid('Wie lange eine Anfrage wartet, wenn alle Ziele ausgelastet sind.'),
  'acl acme_challenge': msgid('Erkennt die Prüfanfragen von Let’s Encrypt (HTTP-01).'),
  'http-request redirect scheme': msgid('Leitet alles außer der ACME-Challenge auf HTTPS um.'),
  'use_backend acme_challenge': msgid('Gibt die ACME-Challenge an acme.sh weiter.'),
  'http-response set-header alt-svc': msgid('Sagt dem Browser, dass HTTP/3 auf Port 443 bereitsteht.'),
  default_backend: msgid('Unbekannte Domains bekommen die Fehlerseite 404.'),
  daemon: msgid(
    'HAProxy läuft im Container im Vordergrund. Das Abbild startet es mit -db, das hebt die Zeile auf. HAPM schreibt sie deshalb nicht.'
  ),
};

function hintFor(key: string): string | null {
  if (HINTS[key]) return HINTS[key];
  if (key.startsWith('errorfile ')) return msgid('Die Fehlerseite von HAPM für diesen Status. Die Datei legt HAPM beim Start an.');
  if (key.startsWith('bind ')) {
    const address = key.slice('bind '.length);
    if (address.startsWith('quic')) return msgid('HTTP/3 über QUIC auf Port 443.');
    if (address.endsWith(':80')) return msgid('Nimmt HTTP an, für die Umleitung auf HTTPS und die ACME-Challenge.');
    if (address.endsWith(':443')) {
      return msgid(
        'HTTPS mit allen Zertifikaten aus dem Verzeichnis. strict-sni: ohne passendes Zertifikat kommt keine Verbindung zustande, statt dass ein fremder Name das Zertifikat einer anderen Domain sieht.'
      );
    }
  }
  return null;
}

/* ── Abschnitte ── */

interface Section {
  /** `global`, `defaults`, `frontend public_http` … so wie im Kopf. */
  head: string;
  /** Index der Kopfzeile. */
  start: number;
  /** Erster Index danach, der nicht mehr dazugehört. */
  end: number;
}

function sections(lines: string[]): Section[] {
  const found: Section[] = [];
  lines.forEach((raw, index) => {
    const line = clean(raw);
    if (!SECTION_KEYWORDS.test(line)) return;
    if (found.length > 0) found[found.length - 1].end = index;
    found.push({ head: normalize(line), start: index, end: lines.length });
  });
  return found;
}

function binds(lines: string[], section: Section): string[] {
  const found: string[] = [];
  for (let i = section.start + 1; i < section.end; i++) {
    const line = normalize(lines[i]);
    if (line.startsWith('bind ')) found.push(directiveKey(line));
  }
  return found;
}

function hasLine(lines: string[], section: Section, wanted: string): boolean {
  for (let i = section.start + 1; i < section.end; i++) if (clean(lines[i]) === wanted) return true;
  return false;
}

/**
 * Der Abschnitt der Datei, der zu einem der Grundkonfiguration gehört. Zuerst
 * nach Namen. Ein importiertes oder von Hand gebautes Frontend heißt oft
 * anders, dann nach seiner Rolle: das mit dem Marker der globalen Einstellungen
 * oder `bind :443` ist das HTTPS-Frontend, das mit `bind :80` das HTTP-Frontend.
 */
function findSection(lines: string[], all: Section[], head: string, https: Section | null): Section | null {
  const named = all.find((section) => section.head === head);
  if (named) return named;
  const frontends = all.filter((section) => section.head.startsWith('frontend '));
  if (head === 'global') return null;
  if (head === 'defaults') {
    // HAProxy wendet auf einen Abschnitt den letzten `defaults` davor an.
    const defaults = all.filter((section) => /^defaults(\s|$)/.test(section.head));
    if (defaults.length === 0) return null;
    if (!https) return defaults[0];
    return defaults.filter((section) => section.start < https.start).pop() ?? defaults[0];
  }
  if (head === 'frontend public_https') {
    return (
      frontends.find((section) => hasLine(lines, section, HTTPS_MARKER)) ??
      frontends.find((section) => binds(lines, section).includes('bind :443')) ??
      null
    );
  }
  if (head === 'frontend public_http') {
    return frontends.find((section) => binds(lines, section).includes('bind :80')) ?? null;
  }
  return null;
}

/** Die Abschnitte, die der Abgleich kennt, in der Reihenfolge der Datei. */
const COMPARED = ['global', 'defaults', 'frontend public_http', 'frontend public_https'];

/* ── Der Vergleich ── */

interface Line {
  index: number;
  text: string;
  key: string;
  /** Wird nie als Abweichung gemeldet, dient aber als Nachbar und wird gepaart,
   *  damit ein Gegenstück in der Datei nicht als Zusatz erscheint. */
  quiet: boolean;
  partner: number | null;
}

interface SectionAnalysis {
  head: string;
  expected: Section;
  actual: Section;
  expLines: Line[];
  actLines: Line[];
}

interface Analysis {
  lines: string[];
  expectedLines: string[];
  sections: SectionAnalysis[];
  missingSections: string[];
  drifts: (BaseConfigDrift & { section: string; expIndex: number | null; actIndex: number | null })[];
}

/** Zeilen, die HAPM anderswo verwaltet, und die Bereiche der Gruppen. */
function managedIndexes(lines: string[]): Set<number> {
  const managed = new Set<number>();
  const block = httpsBlockRange(lines);
  if (block) for (let i = block.start + 1; i < block.end; i++) managed.add(i);
  // Der Zugriffsschutz gehört der Einstellungsseite wie die Admin-ACL.
  const protection = protectionBlockRange(lines);
  if (protection) for (let i = protection.start + 1; i < protection.end; i++) managed.add(i);
  lines.forEach((raw, index) => {
    if (new RegExp(`^acl\\s+${ADMIN_ACL}\\s`).test(clean(raw))) managed.add(index);
  });
  return managed;
}

/** Was zwischen `# BEGIN AUTO …` und dem zugehörigen `# END AUTO …` steht,
 *  beide Marker eingeschlossen. Diese Zeilen sind für den Abgleich nicht da. */
function autoIndexes(lines: string[]): Set<number> {
  const hidden = new Set<number>();
  const markers = scopeMarkers(lines);
  for (const begin of markers.filter((marker) => marker.edge === 'begin')) {
    const end = markers.find(
      (marker) =>
        marker.edge === 'end' &&
        marker.index > begin.index &&
        marker.kind === begin.kind &&
        marker.name.toUpperCase() === begin.name.toUpperCase()
    );
    if (!end) continue;
    for (let i = begin.index; i <= end.index; i++) hidden.add(i);
  }
  return hidden;
}

function collect(
  lines: string[],
  section: Section,
  managed: Set<number>,
  hidden: Set<number>,
  isGlobal: boolean
): Line[] {
  const found: Line[] = [];
  for (let i = section.start + 1; i < section.end; i++) {
    if (hidden.has(i)) continue;
    const text = comparable(lines[i]);
    if (text === '' || text.startsWith('#')) continue;
    const key = directiveKey(text);
    found.push({ index: i, text, key, quiet: managed.has(i) || (isGlobal && key === 'log'), partner: null });
  }
  return found;
}

/** Gegenstücke finden: erst gleiche Zeilen, dann gleiche Direktiven. Die
 *  Zeilen, die gemeldet werden können, kommen jeweils zuerst dran, damit eine
 *  verwaltete Zeile ihnen kein Gegenstück wegnimmt. */
function pair(expLines: Line[], actLines: Line[]): void {
  const ordered = [...expLines.filter((line) => !line.quiet), ...expLines.filter((line) => line.quiet)];
  for (const match of [
    (a: Line, b: Line) => a.text === b.text,
    (a: Line, b: Line) => a.key === b.key,
  ]) {
    for (const exp of ordered) {
      if (exp.partner !== null) continue;
      const act = actLines.find((candidate) => candidate.partner === null && match(exp, candidate));
      if (!act) continue;
      exp.partner = act.index;
      act.partner = exp.index;
    }
  }
}

function driftId(section: string, kind: BaseConfigDriftKind, line: string, occurrence = 0): string {
  return `${section}|${kind}|${line}${occurrence ? `|${occurrence}` : ''}`;
}

function analyze(text: string, options: BaseConfigOptions): Analysis {
  const expectedLines = renderBaseConfig(options).split('\n');
  const lines = text.split('\n');

  const expectedSections = sections(expectedLines);
  const actualSections = sections(lines);
  const expManaged = managedIndexes(expectedLines);
  const actManaged = managedIndexes(lines);
  const actHidden = autoIndexes(lines);

  const httpsHead = 'frontend public_https';
  const https = findSection(lines, actualSections, httpsHead, null);

  const result: Analysis = { lines, expectedLines, sections: [], missingSections: [], drifts: [] };

  for (const head of COMPARED) {
    const expected = expectedSections.find((section) => section.head === head);
    if (!expected) continue;
    const actual = head === httpsHead ? https : findSection(lines, actualSections, head, https);
    if (!actual) {
      result.missingSections.push(head);
      continue;
    }
    // Zwei Rollen auf einem Abschnitt (ein Frontend für HTTP und HTTPS) würden
    // dieselben Zeilen zweimal abgleichen.
    if (result.sections.some((done) => done.actual.start === actual.start)) {
      result.missingSections.push(head);
      continue;
    }

    const isGlobal = head === 'global';
    const expLines = collect(expectedLines, expected, expManaged, new Set(), isGlobal);
    const actLines = collect(lines, actual, actManaged, actHidden, isGlobal);
    pair(expLines, actLines);
    result.sections.push({ head, expected, actual, expLines, actLines });

    for (const exp of expLines) {
      if (exp.quiet) continue;
      if (exp.partner === null) {
        result.drifts.push({
          id: driftId(head, 'missing', exp.text),
          section: head,
          kind: 'missing',
          current: null,
          proposed: clean(expectedLines[exp.index]),
          hint: hintFor(exp.key),
          expIndex: exp.index,
          actIndex: null,
        });
        continue;
      }
      const act = actLines.find((line) => line.index === exp.partner)!;
      if (act.quiet || act.text === exp.text || PRESENCE_ONLY.test(exp.key)) continue;
      result.drifts.push({
        id: driftId(head, 'changed', exp.text),
        section: head,
        kind: 'changed',
        current: clean(lines[act.index]),
        proposed: clean(expectedLines[exp.index]),
        hint: hintFor(exp.key),
        expIndex: exp.index,
        actIndex: act.index,
      });
    }

    const seen = new Map<string, number>();
    for (const act of actLines) {
      if (act.quiet || act.partner !== null) continue;
      const occurrence = seen.get(act.text) ?? 0;
      seen.set(act.text, occurrence + 1);
      result.drifts.push({
        id: driftId(head, 'extra', act.text, occurrence),
        section: head,
        kind: 'extra',
        current: clean(lines[act.index]),
        proposed: null,
        hint: hintFor(act.key),
        expIndex: null,
        actIndex: act.index,
      });
    }
  }

  return result;
}

/** Wo die Datei von der Grundkonfiguration abweicht. */
export function diffBaseConfig(text: string, options: BaseConfigOptions): BaseConfigDiff {
  const analysis = analyze(text, options);
  return {
    ipv6: options.ipv6,
    missingSections: analysis.missingSections,
    drifts: analysis.drifts.map(({ id, section, kind, current, proposed, hint }) => ({
      id,
      section,
      kind,
      current,
      proposed,
      hint,
    })),
  };
}

/** Die Abweichungen, die sich übernehmen lassen. */
export function applicableDrifts(diff: BaseConfigDiff): BaseConfigDrift[] {
  return diff.drifts.filter((drift) => drift.kind !== 'extra');
}

/* ── Übernehmen ── */

const isContent = (raw: string | undefined): boolean => {
  if (raw === undefined) return false;
  const line = clean(raw);
  return line !== '' && !line.startsWith('#');
};

function indentOf(raw: string | undefined): string {
  const indent = /^\s*/.exec(raw ?? '')?.[0] ?? '';
  return indent === '' ? '    ' : indent;
}

/** Die Kommentarzeilen unmittelbar über einer Zeile der Grundkonfiguration. */
function leadingComments(expectedLines: string[], index: number): string[] {
  const found: string[] = [];
  for (let i = index - 1; i >= 0; i--) {
    const line = clean(expectedLines[i]);
    if (!line.startsWith('#')) break;
    found.unshift(line);
  }
  return found;
}

function applyOne(analysis: Analysis, drift: Analysis['drifts'][number]): string[] {
  const lines = [...analysis.lines];
  const proposed = drift.proposed!;

  if (drift.kind === 'changed') {
    lines[drift.actIndex!] = `${indentOf(lines[drift.actIndex!])}${proposed}`;
    return lines;
  }

  const section = analysis.sections.find((entry) => entry.head === drift.section)!;
  const exp = section.expLines;
  const position = exp.findIndex((line) => line.index === drift.expIndex);
  const partnerOf = (line: Line | undefined) => (line && line.partner !== null ? line.partner : null);
  const managed = managedIndexes(lines);

  const prev = exp[position - 1];
  const next = exp[position + 1];
  // Unmittelbare Nachbarn in der Grundkonfiguration: keine Leerzeile, kein
  // Kommentar dazwischen.
  const prevAdjacent = prev && prev.index === drift.expIndex! - 1;
  const nextAdjacent = next && next.index === drift.expIndex! + 1;

  const prevPartner = partnerOf(prev);
  if (prevAdjacent && prevPartner !== null && !managed.has(prevPartner)) {
    lines.splice(prevPartner + 1, 0, `${indentOf(lines[prevPartner])}${proposed}`);
    return lines;
  }
  const nextPartner = partnerOf(next);
  if (nextAdjacent && nextPartner !== null && !managed.has(nextPartner)) {
    lines.splice(nextPartner, 0, `${indentOf(lines[nextPartner])}${proposed}`);
    return lines;
  }

  const { start, end } = section.actual;
  const before = [...exp.slice(0, position)].reverse().find((line) => line.partner !== null);
  if (before) {
    // Hinter die Gruppe des Vorgängers, mit einer Leerzeile davor und dem
    // Kommentar, der in der Grundkonfiguration über der Zeile steht.
    let last = before.partner!;
    while (last + 1 < end && isContent(lines[last + 1]) && !managed.has(last + 1)) last++;
    const indent = indentOf(lines[before.partner!]);
    const comments = leadingComments(analysis.expectedLines, drift.expIndex!).filter(
      (comment) => !lines.slice(start, end).some((raw) => clean(raw) === comment)
    );
    lines.splice(last + 1, 0, '', ...comments.map((comment) => `${indent}${comment}`), `${indent}${proposed}`);
    return lines;
  }
  const after = exp.slice(position + 1).find((line) => line.partner !== null);
  if (after) {
    let first = after.partner!;
    while (first - 1 > start && isContent(lines[first - 1])) first--;
    lines.splice(first, 0, `${indentOf(lines[after.partner!])}${proposed}`, '');
    return lines;
  }

  // Nichts aus der Grundkonfiguration steht im Abschnitt: ans Ende seines Inhalts.
  let last = start;
  for (let i = start + 1; i < end; i++) if (isContent(lines[i])) last = i;
  const insert = last === start ? [`    ${proposed}`] : ['', `${indentOf(lines[last])}${proposed}`];
  lines.splice(last + 1, 0, ...insert);
  return lines;
}

/**
 * Die ausgewählten Abweichungen in den Text schreiben.
 *
 * Eine ID, die es nicht (mehr) gibt, bricht ab: die Auswahl stammt aus einer
 * Ansicht von vorhin, und wer inzwischen die Datei geändert hat, soll nicht
 * etwas anderes bekommen, als er angeklickt hat. Zusätze lassen sich nicht
 * übernehmen, es wird nichts gelöscht.
 */
export function applyBaseConfigDrifts(text: string, options: BaseConfigOptions, ids: string[]): string {
  const wanted = new Set(ids);
  const initial = analyze(text, options);
  const order = initial.drifts.filter((drift) => wanted.has(drift.id));
  for (const id of wanted) {
    const drift = order.find((entry) => entry.id === id);
    if (!drift) {
      throw new HaproxyConfigError(
        msg('Die Abweichung „{id}" gibt es in der Konfiguration nicht mehr. Bitte die Seite neu laden.', { id })
      );
    }
    if (drift.kind === 'extra') {
      throw new HaproxyConfigError(
        msg('Zeilen, die es nur in dieser Datei gibt, werden nicht angefasst: {line}', { line: drift.current ?? '' })
      );
    }
  }

  let current = text;
  for (const { id } of order) {
    const analysis = analyze(current, options);
    const drift = analysis.drifts.find((entry) => entry.id === id);
    if (!drift) continue;
    current = applyOne(analysis, drift).join('\n');
  }
  return current;
}
