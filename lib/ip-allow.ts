/**
 * Von welchen Adressen ein Dienst-Token gelten darf.
 *
 * ── Was diese Datei ist und was nicht ──
 *
 * Sie ist die **zweite** Hürde, nie die erste. Wer hier durchkommt, hat den
 * Hash bereits getroffen; wer ihn nicht trifft, kommt gar nicht bis hierher.
 * Eine Adressliste ersetzt also kein Token, sie begrenzt den Schaden eines
 * geleakten: ein Schlüssel, der aus einem versehentlich veröffentlichten Repo
 * gefischt wird, nützt niemandem, der nicht auch auf dem freigegebenen Server
 * sitzt.
 *
 * ── Warum leer „von überall" heißt ──
 *
 * Die Spalte kam nach den
 * Token. Eine leere Liste als „von nirgendwo" zu lesen hätte beim Deploy jeden
 * bestehenden Zugang abgeräumt, ohne dass jemand etwas geändert hat. Wer eine
 * Grenze will, trägt sie ein; wer keine einträgt, hat gesagt, dass er keine
 * will.
 *
 * ── Woher die Adresse kommt ──
 *
 * Aus `getClientIP` und damit aus dem **rechtesten** X-Forwarded-For-Eintrag
 * bzw. dem X-Real-IP, den Traefik setzt. Der linkeste Eintrag ist vom Aufrufer
 * frei wählbar — eine Freigabe, die sich mit einem Header umgehen lässt, ist
 * keine Freigabe, sondern eine Anzeige. Steht so schon in `lib/audit.ts` und
 * gilt hier aus demselben Grund.
 *
 * ── Warum verglichen wird und nicht gerechnet ──
 *
 * Adressen werden zu Bytes normalisiert und dann bitweise verglichen. Ein
 * Textvergleich hätte drei Fallen auf einmal: `::1` und `0:0:0:0:0:0:0:1` sind
 * dieselbe Adresse, `10.0.0.7` fällt in `10.0.0.0/8` ohne dass ein Präfix des
 * Textes das zeigt, und `10.0.0.0/8` als Text enthält `10.0.0.70` genauso wie
 * `110.0.0.7` nicht enthält.
 */

import { validateIP, validateIPRange } from './validation';

/** Zwei Adressen sind vergleichbar, wenn sie dieselbe Länge haben: 4 oder 16. */
type Bytes = number[];

/**
 * IPv4 in vier Bytes. `null`, wenn es keine ist.
 *
 * Führende Nullen werden abgelehnt (`010.0.0.1`): manche Bibliotheken lesen
 * sie oktal, andere dezimal, und eine Freigabe, die je nach Leser eine andere
 * Adresse meint, ist eine Falle statt einer Regel.
 */
function parseV4(value: string): Bytes | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;

  const out: Bytes = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith('0')) return null;
    const n = Number(part);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** IPv6 in sechzehn Bytes, samt `::`-Kurzform und eingebettetem IPv4. */
function parseV6(value: string): Bytes | null {
  if (!value.includes(':')) return null;

  // Genau ein `::` ist erlaubt, sonst wäre die Länge der Lücke nicht bestimmt.
  const halves = value.split('::');
  if (halves.length > 2) return null;

  const readGroups = (text: string): Bytes | null => {
    if (text === '') return [];
    const out: Bytes = [];
    const groups = text.split(':');
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      // Ein IPv4-Teil darf nur ganz am Ende stehen (`::ffff:10.0.0.1`).
      if (group.includes('.')) {
        if (i !== groups.length - 1) return null;
        const v4 = parseV4(group);
        if (!v4) return null;
        out.push(...v4);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      const n = parseInt(group, 16);
      out.push((n >> 8) & 0xff, n & 0xff);
    }
    return out;
  };

  const head = readGroups(halves[0]);
  const tail = halves.length === 2 ? readGroups(halves[1]) : [];
  if (head === null || tail === null) return null;

  if (halves.length === 1) return head.length === 16 ? head : null;

  const gap = 16 - head.length - tail.length;
  if (gap < 1) return null;
  return [...head, ...Array(gap).fill(0), ...tail];
}

/**
 * Eine Adresse in ihre Bytes, in der Form, in der sie verglichen wird.
 *
 * IPv4-mapped IPv6 (`::ffff:10.0.0.1`) wird auf die vier Bytes zurückgeführt.
 * Ohne das trüge ein Node-Server im Dual-Stack-Betrieb dieselbe Adresse in zwei
 * Schreibweisen vor, und eine Freigabe `10.0.0.1` griffe je nach Tagesform.
 */
export function ipToBytes(value: string): Bytes | null {
  const trimmed = value.trim().replace(/^\[|\]$/g, '');
  if (!trimmed) return null;

  const v4 = parseV4(trimmed);
  if (v4) return v4;

  const v6 = parseV6(trimmed);
  if (!v6) return null;

  const mapped = v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff;
  return mapped ? v6.slice(12) : v6;
}

/** Stimmen die ersten `bits` Bits überein? */
function samePrefix(a: Bytes, b: Bytes, bits: number): boolean {
  if (a.length !== b.length) return false;
  const full = Math.floor(bits / 8);
  for (let i = 0; i < full; i++) {
    if (a[i] !== b[i]) return false;
  }
  const rest = bits % 8;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return (a[full] & mask) === (b[full] & mask);
}

/**
 * Fällt `ip` in den Eintrag `entry`?
 *
 * `entry` ist entweder eine einzelne Adresse oder ein CIDR-Bereich. Alles, was
 * sich nicht als das eine oder das andere lesen lässt, gibt `false` — ein
 * unlesbarer Eintrag erlaubt nichts, statt versehentlich alles zu erlauben.
 */
export function ipMatches(entry: string, ip: string): boolean {
  const [addr, bits] = entry.includes('/') ? entry.split('/') : [entry, null];

  const target = ipToBytes(ip);
  const allowed = ipToBytes(addr);
  if (!target || !allowed) return false;

  // Eine IPv4-Freigabe trifft keine IPv6-Adresse und umgekehrt. Der Aufrufer
  // hinter einem Dual-Stack-Anschluss braucht deshalb beide Einträge — das ist
  // die ehrliche Antwort, ein stillschweigendes „passt schon" wäre die andere.
  if (target.length !== allowed.length) return false;

  if (bits === null) return samePrefix(allowed, target, allowed.length * 8);

  const prefix = Number(bits);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > allowed.length * 8) return false;
  return samePrefix(allowed, target, prefix);
}

/**
 * Die gespeicherte Liste lesen.
 *
 * Ungültige Einträge fallen weg. Anders als bei den Bereichen ist das hier
 * folgenlos für die Richtung, in die es irren darf: eine Liste, aus der ein
 * Eintrag verschwindet, erlaubt WENIGER, nicht mehr. Bleibt gar nichts übrig,
 * ist die Liste leer — und leer heißt „von überall", was die einzige Stelle
 * ist, an der man aufpassen muss. Deshalb prüft `normaliseAllowedIps` beim
 * Speichern, statt sich auf das Lesen zu verlassen.
 */
export function parseAllowedIps(raw: string | null | undefined): string[] {
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed.filter(
    (entry): entry is string =>
      typeof entry === 'string' && (validateIP(entry) || validateIPRange(entry))
  );
}

export function serialiseAllowedIps(entries: string[]): string {
  return JSON.stringify(entries);
}

/**
 * Was aus dem Formular kommt, in die Form bringen, in der es gespeichert wird.
 *
 * Wirft bei einem ungültigen Eintrag, statt ihn wegzulassen: wer `10.0.0.` in
 * das Feld tippt und eine gespeicherte Liste ohne diese Zeile zurückbekommt,
 * hält den Zugang für enger, als er ist. Das ist genau die Richtung, in die
 * eine Freigabe nicht irren darf.
 */
export function normaliseAllowedIps(input: unknown): string[] {
  if (input === null || input === undefined) return [];
  if (!Array.isArray(input)) throw new Error('Die Adressliste muss eine Liste sein.');

  const out: string[] = [];
  for (const raw of input) {
    const entry = String(raw ?? '').trim();
    if (!entry) continue;
    if (!validateIP(entry) && !validateIPRange(entry)) {
      throw new Error(`"${entry}" ist keine gültige IP-Adresse und kein CIDR-Bereich.`);
    }
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/**
 * Darf dieses Token von dieser Adresse aus?
 *
 * Eine leere Liste heißt „von überall" — Begründung oben. Eine Adresse, die
 * sich nicht lesen lässt (`getClientIP` gibt `unknown`, wenn kein Proxy-Header
 * ankommt), fällt bei einer gesetzten Liste durch: wer eine Freigabe einträgt,
 * hat gesagt, dass er die Herkunft geprüft haben will, und „ich weiß es nicht"
 * ist keine Prüfung.
 */
export function ipAllowed(entries: string[], ip: string): boolean {
  if (entries.length === 0) return true;
  return entries.some((entry) => ipMatches(entry, ip));
}
