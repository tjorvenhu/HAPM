/**
 * IP → Land, und zwar hier im Prozess.
 *
 * Der Reverse-Proxy-Statistik fehlt genau eine Auskunft, die weder `show stat`
 * noch das Access-Log selbst hergibt: zu welchem Land eine Adresse gehört. Die
 * naheliegende Lösung wäre ein Aufruf gegen einen Dienst wie ip-api.com
 * gewesen. Dagegen spricht nicht Bequemlichkeit, sondern was dabei abfließt:
 * die Adressen der Besucher der Seiten hinter dem Proxy, einzeln und
 * zeitgestempelt, an einen Dritten. HAPM gibt sonst keine Adresse eines
 * Besuchers nach außen.
 *
 * Also eine Tabelle, die mitgeliefert wird und im Prozess nachgeschlagen wird.
 * Woher sie kommt und wie sie erneuert wird, steht in `./store.ts` — diese Datei
 * kann nur eines: aus Textzeilen eine kompakte Form machen und darin suchen.
 *
 * **Ohne Importe außer `lib/i18n` (rein)**, aus demselben Grund wie bei
 * `lib/haproxy/config.ts`: die Übersetzung wird an zwei Stellen gebraucht (beim
 * Erzeugen der Repo-Datei und beim Hochladen einer neuen Fassung), und beide
 * müssen dieselbe Bedeutung haben. Rein heißt hier außerdem: prüfbar, ohne dass
 * eine 4-MB-Datei im Test liegt.
 *
 * ── Warum nur die Anfänge gespeichert werden ──
 *
 * Ein Datensatz von DB-IP ist eine Liste von Bereichen mit Anfang, Ende und
 * Land. Gespeichert wird hier nur der **Anfang**, und die Suche nimmt den
 * größten Anfang unterhalb der gesuchten Adresse. Das ist exakt und keine
 * Näherung, denn der Datensatz kachelt den gesamten Adressraum lückenlos: von
 * `0.0.0.0` bis `255.255.255.255` und von `::` bis `ffff:…:ffff` schließt jeder
 * Bereich unmittelbar an seinen Vorgänger an. Die Enden mitzuschreiben
 * verdoppelte die Datei für eine Zahl, die sich aus dem nächsten Anfang ergibt.
 *
 * Verlassen wird sich darauf trotzdem nicht: findet `compileGeoTable` eine
 * Lücke, schreibt es an deren Anfang einen ausdrücklichen Unbekannt-Eintrag.
 * Ohne den läge dort das Land des Bereichs davor — eine falsche Flagge ist
 * schlimmer als ein Strich, siehe „Ehrliche Nullwerte" in CLAUDE.md.
 *
 * ── Warum IPv6 auf 64 Bit gekürzt wird ──
 *
 * Ein voller IPv6-Anfang sind 16 Byte, bei 350 000 Bereichen also 5,6 MB allein
 * für die Adressen. Länder werden aber nicht feiner als ein /64 vergeben: im
 * Datensatz von 2026-08 liegen 59 von 348 330 Bereichen innerhalb eines
 * einzelnen /64, alle übrigen sind mindestens so groß. Gekürzt wird deshalb auf
 * die oberen 64 Bit, und die 59 feineren Bereiche fallen mit ihrem Nachbarn
 * zusammen.
 *
 * ── Warum Delta und Varint ──
 *
 * Die Anfänge stehen sortiert, und benachbarte Bereiche liegen dicht
 * beieinander. Als Differenz zum Vorgänger geschrieben passen die meisten in
 * ein oder zwei Byte statt in vier bzw. acht. Das ist der Unterschied zwischen
 * 9,3 MB und 2,8 MB roh — und nach dem gzip in `./store.ts` zwischen 3,5 MB und
 * 790 KB im Repository.
 */

import { interpolate, msg, type Message, type Params } from '../i18n/translate';

/* ══════════════════════════════════════════════════════════════════════
 * Adressen
 * ══════════════════════════════════════════════════════════════════════ */

/** Der Suchschlüssel einer Adresse: ihre Familie und ihr Zahlenwert. */
export interface IpKey {
  family: 4 | 6;
  /** IPv4: die vollen 32 Bit. IPv6: die oberen 64 Bit, siehe Kopf der Datei. */
  key: bigint;
}

/**
 * Eine Adresse als Zahl, oder `null`.
 *
 * `null` heißt: das war keine Adresse. Ein Access-Log enthält solche Felder
 * wirklich — HAProxy schreibt `-`, wenn die Verbindung abbrach, bevor eine
 * Quelle feststand. Sie als 0 zu lesen legte alles unter `0.0.0.0` ab, und das
 * ist im Datensatz ein Land wie jedes andere.
 *
 * Angenommen werden auch die Formen, in denen eine Adresse aus einem Log kommt:
 * mit Port dahinter kümmert sich der Aufrufer, hier reicht die nackte Adresse
 * samt der IPv4-in-IPv6-Schreibweise (`::ffff:1.2.3.4`), die HAProxy auf einem
 * Socket mit `v4v6` schreibt. Sie wird zu IPv4 aufgelöst und nicht als IPv6
 * gesucht: sonst landete jeder IPv4-Besucher im `::ffff:0:0/96`-Bereich.
 */
export function ipToKey(text: string): IpKey | null {
  const value = text.trim();
  if (!value) return null;

  if (!value.includes(':')) {
    const key = ipv4ToNumber(value);
    return key === null ? null : { family: 4, key };
  }

  // `::ffff:1.2.3.4` und `::ffff:0102:0304` sind dieselbe IPv4-Adresse.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped) {
    const key = ipv4ToNumber(mapped[1]);
    return key === null ? null : { family: 4, key };
  }

  const full = ipv6ToBigInt(value);
  if (full === null) return null;
  if (full >= 0xffffn << 32n && full < (0xffffn << 32n) + (1n << 32n)) {
    return { family: 4, key: full & 0xffffffffn };
  }
  // Nur die oberen 64 Bit, siehe Kopf der Datei.
  return { family: 6, key: full >> 64n };
}

/**
 * Eine Adresse mit allen Bits, für den Vergleich mit einem Netz
 * (`lib/geoip/networks.ts`). Anders als `ipToKey` ohne Kürzung: ob eine
 * Adresse in einem /128 liegt, lässt sich mit 64 Bit nicht sagen.
 * IPv4-in-IPv6 wird zu IPv4 wie dort.
 */
export function parseAddress(text: string): IpKey | null {
  const value = text.trim().replace(/^::ffff:(?=\d{1,3}(?:\.\d{1,3}){3}$)/i, '');
  if (!value) return null;
  if (!value.includes(':')) {
    const key = ipv4ToNumber(value);
    return key === null ? null : { family: 4, key };
  }
  const full = ipv6ToBigInt(value);
  if (full === null) return null;
  if (full >= 0xffffn << 32n && full < (0xffffn << 32n) + (1n << 32n)) {
    return { family: 4, key: full & 0xffffffffn };
  }
  return { family: 6, key: full };
}

function ipv4ToNumber(value: string): bigint | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let out = 0n;
  for (const part of parts) {
    // `Number('')` ist 0 und `Number('1e2')` ist 100 — beides wäre hier eine
    // erfundene Adresse. Deshalb erst die Form, dann der Wert.
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    out = (out << 8n) | BigInt(octet);
  }
  return out;
}

function ipv6ToBigInt(value: string): bigint | null {
  if (!/^[0-9a-f:.]+$/i.test(value)) return null;

  const sides = value.split('::');
  if (sides.length > 2) return null;

  const expand = (side: string): string[] | null => {
    if (!side) return [];
    const groups: string[] = [];
    for (const raw of side.split(':')) {
      if (raw === '') return null;
      // Eine eingebettete IPv4-Schreibweise am Ende zählt als zwei Gruppen.
      if (raw.includes('.')) {
        const embedded = ipv4ToNumber(raw);
        if (embedded === null) return null;
        groups.push(((embedded >> 16n) & 0xffffn).toString(16));
        groups.push((embedded & 0xffffn).toString(16));
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(raw)) return null;
      groups.push(raw);
    }
    return groups;
  };

  const head = expand(sides[0] ?? '');
  const tail = sides.length === 2 ? expand(sides[1] ?? '') : [];
  if (head === null || tail === null) return null;

  const missing = 8 - head.length - tail.length;
  // Ohne `::` muss die Adresse vollständig sein; mit `::` muss sie kürzen.
  if (sides.length === 1 ? missing !== 0 : missing < 1) return null;

  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  let out = 0n;
  for (const group of groups) out = (out << 16n) | BigInt(parseInt(group, 16));
  return out;
}

/* ══════════════════════════════════════════════════════════════════════
 * Die kompakte Form
 * ══════════════════════════════════════════════════════════════════════ */

const MAGIC = 'VGEO1';

/** Das Land eines Bereichs, für den der Datensatz keines nennt. Es steht als
 *  echter Eintrag in der Tabelle und wird beim Nachschlagen zu `null` — ein
 *  Land namens „ZZ" gibt es nicht, und der Aufrufer soll „unbekannt" sehen. */
export const UNKNOWN_COUNTRY = 'ZZ';

/** Was über einer Tabelle steht: woher sie kommt und wie alt sie ist. */
export interface GeoTableMeta {
  /** Der Stand des Datensatzes, so wie der Anbieter ihn nennt: `2026-08`. */
  version: string;
  /** Woher er stammt, für die Anzeige. */
  source: string;
  /** Wann diese Fassung erzeugt wurde, ISO. */
  builtAt: string;
}

export interface GeoTable extends GeoTableMeta {
  countries: string[];
  /** Aufsteigend sortierte Bereichsanfänge, 32 Bit. */
  starts4: Uint32Array;
  /** Der Landindex zum Anfang an derselben Stelle. */
  codes4: Uint8Array;
  /** Dasselbe für IPv6, gekürzt auf die oberen 64 Bit. */
  starts6: BigUint64Array;
  codes6: Uint8Array;
}

/**
 * Was beim Übersetzen schiefgehen kann, mit einem Satz für das Formular.
 *
 * Ist selbst eine `Message` wie `HaproxyConfigError`: eine Route reicht ihn als
 * `new ApiError(err)` weiter und übersetzt ihn dort. `message` bleibt der
 * deutsche Text samt Werten.
 */
export class GeoTableError extends Error implements Message {
  readonly text: string;
  readonly params?: Params;

  constructor(message: string | Message) {
    const text = typeof message === 'string' ? message : message.text;
    const params = typeof message === 'string' ? undefined : message.params;
    super(interpolate(text, params));
    this.name = 'GeoTableError';
    this.text = text;
    this.params = params;
  }
}

/* ── Varint ── */

function pushVarint(out: number[], value: number): void {
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
}

function pushVarintBig(out: number[], value: bigint): void {
  let rest = value;
  while (rest >= 0x80n) {
    out.push(Number(rest & 0x7fn) | 0x80);
    rest >>= 7n;
  }
  out.push(Number(rest));
}

/** Ein Zeiger, der beim Lesen mitwandert. Ein Rückgabepaar je Varint wäre bei
 *  700 000 Werten eine Million kurzlebiger Objekte. */
interface Cursor {
  at: number;
}

function readVarint(bytes: Uint8Array, cursor: Cursor): number {
  let out = 0;
  let scale = 1;
  for (;;) {
    if (cursor.at >= bytes.length) throw new GeoTableError(msg('Die Datei bricht mitten in einer Zahl ab.'));
    const byte = bytes[cursor.at++];
    out += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) return out;
    scale *= 128;
  }
}

function readVarintBig(bytes: Uint8Array, cursor: Cursor): bigint {
  let out = 0n;
  let shift = 0n;
  for (;;) {
    if (cursor.at >= bytes.length) throw new GeoTableError(msg('Die Datei bricht mitten in einer Zahl ab.'));
    const byte = bytes[cursor.at++];
    out |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return out;
    shift += 7n;
  }
}

/* ── Übersetzen ── */

interface Entry {
  key: bigint;
  code: string;
}

/**
 * Ein DB-IP-CSV in die kompakte Form.
 *
 * Erwartet wird das Format des Datensatzes „IP to Country Lite": drei Spalten
 * ohne Kopfzeile, `Anfang,Ende,Ländercode`, IPv4 und IPv6 gemischt in derselben
 * Datei.
 *
 * Unbrauchbare Zeilen werden **übersprungen und nicht als Fehler geworfen**.
 * Eine einzelne kaputte Zeile ist kein Grund, eine Tabelle mit 700 000
 * brauchbaren wegzuwerfen; dass am Ende überhaupt etwas dasteht, prüft der
 * Aufrufer an `v4Count`/`v6Count`.
 */
export function compileGeoTable(
  csv: string,
  meta: GeoTableMeta
): { bytes: Uint8Array; countries: string[]; v4Count: number; v6Count: number } {
  const v4: Entry[] = [];
  const v6: Entry[] = [];

  for (const line of csv.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const cells = trimmed.split(',');
    if (cells.length < 3) continue;

    const code = cells[2].trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) continue;

    const start = ipToKey(cells[0]);
    if (!start) continue;
    // Das Ende zählt nur für die Lückenprüfung unten.
    const end = ipToKey(cells[1]);
    if (start.family === 6) {
      /* Die Tabelle kennt bei IPv6 nur /64. Ein Bereich, der mitten in einem
       * /64 anfängt (weil davor ein einzelner Host eines anderen Landes
       * herausgeschnitten ist), hätte denselben Schlüssel wie der Bereich davor,
       * fiele als Doppelter weg, und seine Endmarke machte alles dahinter zu
       * „unbekannt": Besucher ohne Land, und Adressen eines gesperrten Landes,
       * die in keiner Sperrliste stehen. Deshalb gehört jedes /64 dem Bereich,
       * der an seinem Anfang gilt: der Anfang wird auf die nächste Grenze
       * aufgerundet, und ein Bereich, der kein ganzes /64 beginnt, entfällt. */
      const fullStart = parseAddress(cells[0]);
      const fullEnd = parseAddress(cells[1]);
      if (!fullStart || fullStart.family !== 6) continue;
      const startKey = (fullStart.key + (1n << 64n) - 1n) >> 64n;
      if (fullEnd && fullEnd.family === 6 && fullEnd.key >= fullStart.key) {
        const endKey = fullEnd.key >> 64n;
        if (startKey > endKey) continue;
        v6.push({ key: startKey, code }, { key: endKey + 1n, code: '' });
      } else {
        v6.push({ key: startKey, code });
      }
      continue;
    }
    v4.push({ key: start.key, code });
    if (end && end.family === 4 && end.key >= start.key) {
      v4.push({ key: end.key + 1n, code: '' });
    }
  }

  const table4 = normalise(v4, 0xffffffffn);
  const table6 = normalise(v6, (1n << 64n) - 1n);

  const countries = [...new Set([...table4, ...table6].map((e) => e.code))].sort();
  if (countries.length > 256) {
    throw new GeoTableError(
      msg('Die Datei nennt {count} Länder. Mehr als 256 kann diese Tabelle nicht führen.', {
        count: countries.length,
      })
    );
  }
  const indexOf = new Map(countries.map((code, index) => [code, index]));

  const body: number[] = [];
  body.push(countries.length === 256 ? 0 : countries.length); // 256 als 0, siehe decode
  for (const code of countries) body.push(code.charCodeAt(0), code.charCodeAt(1));

  pushVarint(body, table4.length);
  let previous4 = 0n;
  for (const entry of table4) {
    pushVarint(body, Number(entry.key - previous4));
    previous4 = entry.key;
    body.push(indexOf.get(entry.code)!);
  }

  pushVarint(body, table6.length);
  let previous6 = 0n;
  for (const entry of table6) {
    pushVarintBig(body, entry.key - previous6);
    previous6 = entry.key;
    body.push(indexOf.get(entry.code)!);
  }

  const header = new TextEncoder().encode(`${MAGIC}\n${JSON.stringify(meta)}\n`);
  const bytes = new Uint8Array(header.length + body.length);
  bytes.set(header, 0);
  bytes.set(Uint8Array.from(body), header.length);

  return { bytes, countries, v4Count: table4.length, v6Count: table6.length };
}

/**
 * Sortieren, Lücken schließen, Doppelte entfernen.
 *
 * Die Einträge mit leerem Code sind die Enden aus dem CSV: sie markieren „ab
 * hier sagt dieser Bereich nichts mehr". Bleibt so einer stehen, weil kein
 * anderer Bereich an derselben Stelle anfängt, ist dort eine Lücke — und die
 * wird als `UNKNOWN_COUNTRY` festgehalten, statt das Land davor weiterlaufen zu
 * lassen. Steht an derselben Stelle ein echter Anfang, gewinnt der.
 *
 * ── Warum das ZWEI Durchläufe sind ──
 *
 * Weil beide Regeln auf dieselbe Stelle zugreifen und sich sonst gegenseitig
 * aushebeln. In einem Durchlauf zusammengelegt sah es so aus: bei zwei
 * benachbarten Bereichen desselben Landes wird der zweite Anfang als
 * Fortsetzung weggelassen — und dann traf die Endmarke an genau seinem
 * Schlüssel nicht mehr auf ihn, sondern auf den Eintrag davor, und wurde als
 * Lücke übernommen. Aus zwei zusammenhängenden deutschen Bereichen wurde
 * dadurch „DE, dann unbekannt".
 *
 * Also erst je Schlüssel EINEN Eintrag bestimmen, und danach über die
 * bereinigte Folge zusammenfassen.
 */
function normalise(entries: Entry[], max: bigint): Entry[] {
  entries.sort((a, b) => {
    if (a.key < b.key) return -1;
    if (a.key > b.key) return 1;
    // Der echte Anfang vor der Endmarke, damit er beim Zusammenfallen gewinnt.
    return a.code === '' ? 1 : b.code === '' ? -1 : 0;
  });

  // 1. Ein Eintrag je Schlüssel.
  const unique: Entry[] = [];
  for (const entry of entries) {
    // Ein Ende jenseits des Adressraums hat keinen Nachfolger mehr.
    if (entry.key > max) continue;
    const previous = unique[unique.length - 1];
    if (previous && previous.key === entry.key) continue;
    unique.push({ key: entry.key, code: entry.code === '' ? UNKNOWN_COUNTRY : entry.code });
  }

  // 2. Zwei gleiche Länder hintereinander sind ein Bereich.
  const out: Entry[] = [];
  for (const entry of unique) {
    const previous = out[out.length - 1];
    if (previous && previous.code === entry.code) continue;
    out.push(entry);
  }

  // Der Anfang des Adressraums muss belegt sein, sonst hätte die Suche unterhalb
  // des ersten Eintrags keine Antwort.
  if (out.length === 0 || out[0].key !== 0n) {
    out.unshift({ key: 0n, code: UNKNOWN_COUNTRY });
  }
  return out;
}

/* ── Zurücklesen ── */

export function decodeGeoTable(bytes: Uint8Array): GeoTable {
  const text = new TextDecoder().decode(bytes.subarray(0, 512));
  const firstBreak = text.indexOf('\n');
  const secondBreak = text.indexOf('\n', firstBreak + 1);
  if (firstBreak < 0 || secondBreak < 0 || text.slice(0, firstBreak) !== MAGIC) {
    throw new GeoTableError(msg('Das ist keine übersetzte Länder-Tabelle.'));
  }

  let meta: GeoTableMeta;
  try {
    meta = JSON.parse(text.slice(firstBreak + 1, secondBreak)) as GeoTableMeta;
  } catch {
    throw new GeoTableError(msg('Der Kopf der Länder-Tabelle ist unlesbar.'));
  }

  // Der Kopf ist ASCII, also ist die Zeichenzahl auch die Byteanzahl.
  const cursor: Cursor = { at: secondBreak + 1 };

  const rawCount = bytes[cursor.at++];
  const countryCount = rawCount === 0 ? 256 : rawCount;
  const countries: string[] = [];
  for (let i = 0; i < countryCount; i++) {
    countries.push(String.fromCharCode(bytes[cursor.at++], bytes[cursor.at++]));
  }

  const count4 = readVarint(bytes, cursor);
  const starts4 = new Uint32Array(count4);
  const codes4 = new Uint8Array(count4);
  let previous4 = 0;
  for (let i = 0; i < count4; i++) {
    previous4 += readVarint(bytes, cursor);
    starts4[i] = previous4;
    codes4[i] = bytes[cursor.at++];
  }

  const count6 = readVarint(bytes, cursor);
  const starts6 = new BigUint64Array(count6);
  const codes6 = new Uint8Array(count6);
  let previous6 = 0n;
  for (let i = 0; i < count6; i++) {
    previous6 += readVarintBig(bytes, cursor);
    starts6[i] = previous6;
    codes6[i] = bytes[cursor.at++];
  }

  return { ...meta, countries, starts4, codes4, starts6, codes6 };
}

/* ══════════════════════════════════════════════════════════════════════
 * Nachschlagen
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * Das Land einer Adresse, oder `null`.
 *
 * `null` heißt unbekannt und nie „irgendwo": keine lesbare Adresse, keine
 * Tabelle, oder ein Bereich, für den der Datensatz kein Land nennt. Der
 * Aufrufer zeigt dafür einen Strich und keine Flagge.
 */
export function lookupCountry(table: GeoTable | null, ip: string): string | null {
  if (!table) return null;
  const parsed = ipToKey(ip);
  if (!parsed) return null;

  if (parsed.family === 4) {
    const index = floorIndex(table.starts4, Number(parsed.key));
    if (index < 0) return null;
    return named(table, table.codes4[index]);
  }

  const index = floorIndexBig(table.starts6, parsed.key);
  if (index < 0) return null;
  return named(table, table.codes6[index]);
}

function named(table: GeoTable, index: number): string | null {
  const code = table.countries[index];
  if (!code || code === UNKNOWN_COUNTRY) return null;
  return code;
}

/** Die Stelle des größten Anfangs, der nicht über dem Suchwert liegt. */
function floorIndex(starts: Uint32Array, key: number): number {
  let low = 0;
  let high = starts.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (starts[middle] <= key) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

function floorIndexBig(starts: BigUint64Array, key: bigint): number {
  let low = 0;
  let high = starts.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (starts[middle] <= key) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}
