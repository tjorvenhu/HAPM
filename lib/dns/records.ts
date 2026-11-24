/**
 * Was ein DNS-Eintrag ist und was als Eingabe durchgeht.
 *
 * Ohne Importe, wie `zones.ts`: der Dialog prüft mit derselben Funktion wie die
 * Route. Zwei Regelwerke wären ein Formular, das etwas annimmt, das Cloudflare
 * danach mit einer englischen Fehlermeldung ablehnt.
 *
 * ── Warum die Liste der Arten kurz ist ──
 *
 * `EDITABLE_TYPES` ist eine Allow-Liste, aus demselben Grund wie die
 * DNS-Anbieter in `haproxy/`: die Art
 * bestimmt, welche Felder mitgeschickt werden, und was nicht in der Liste steht,
 * hat Felder, die dieses Formular gar nicht kennt (SRV trägt Priorität, Gewicht
 * und Port in einem `data`-Objekt, CAA Flag und Tag).
 *
 * **Was nicht darin steht, wird angezeigt und nicht angefasst** — dieselbe Regel
 * wie bei einem HAProxy-Eintrag, der nicht dem Namensschema folgt. Ein Werkzeug,
 * das einen SRV-Eintrag beim Speichern auf seine drei bekannten Felder
 * zusammenstreicht, ist schlimmer als eines, das ihn nur zeigt.
 */

export const EDITABLE_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS'] as const;
export type EditableRecordType = (typeof EDITABLE_TYPES)[number];

/** Nur diese drei kann Cloudflare über seine Server schicken. */
export const PROXYABLE_TYPES: readonly string[] = ['A', 'AAAA', 'CNAME'];

/** Cloudflare: 1 heißt „automatisch", sonst mindestens 60 Sekunden. */
export const TTL_AUTO = 1;
const TTL_MIN = 60;
const TTL_MAX = 86400;

/** Ein Eintrag, wie Cloudflare ihn führt — auf das reduziert, was hier zählt. */
export interface DnsRecord {
  id: string;
  type: string;
  /** Der volle Name, so wie Cloudflare ihn zurückgibt. */
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  priority: number | null;
  comment: string | null;
  /** Von Cloudflare gepflegte Einträge (z. B. der SOA) lassen sich nicht ändern. */
  locked: boolean;
}

/** Was aus dem Formular kommt. `name` ist relativ zur Zone, `@` ist die Zone. */
export interface RecordInput {
  type: EditableRecordType;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  priority: number | null;
  comment: string | null;
}

export function isEditableType(type: string): type is EditableRecordType {
  return (EDITABLE_TYPES as readonly string[]).includes(type);
}

/** Ob dieser Eintrag über die Oberfläche geändert werden darf. */
export function isEditableRecord(record: Pick<DnsRecord, 'type' | 'locked'>): boolean {
  return !record.locked && isEditableType(record.type);
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
/** Grob und mit Absicht: die genaue Form prüft Cloudflare, hier geht es um Tippfehler. */
const IPV6 = /^[0-9a-f:]+$/i;
/** Ein Hostname als Ziel. Der Unterstrich ist erlaubt: `_acme-challenge` gibt es wirklich. */
const HOSTNAME = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*\.?$/i;
/** Ein Eintragsname innerhalb der Zone. `@` ist die Zone, `*` die Wildcard. */
const RECORD_NAME = /^(@|\*|(\*\.)?[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*)$/i;

/**
 * Prüft eine Eingabe. Zurück kommt die Meldung oder `null`.
 *
 * Deutsch und mit dem Grund daneben, wo es einen gibt: „Ungültig" schickt jemanden
 * in die Suche, „Ein CNAME zeigt auf einen Namen, nicht auf eine IP" nicht.
 */
export function validateRecordInput(input: RecordInput, zoneName: string): string | null {
  if (!isEditableType(input.type)) {
    return `Einträge vom Typ ${input.type} lassen sich hier nicht anlegen.`;
  }

  const name = input.name.trim().toLowerCase();
  if (name === '') return 'Bitte einen Namen angeben. `@` steht für die Domain selbst.';
  if (!RECORD_NAME.test(name)) {
    return 'Der Name enthält Zeichen, die in keinem DNS-Namen vorkommen.';
  }
  if (name.length > 253) return 'Der Name ist zu lang.';

  const content = input.content.trim();
  if (content === '') return 'Bitte einen Wert angeben.';

  switch (input.type) {
    case 'A':
      if (!IPV4.test(content)) return 'Ein A-Eintrag zeigt auf eine IPv4-Adresse, z. B. 203.0.113.10.';
      break;
    case 'AAAA':
      if (!IPV6.test(content) || !content.includes(':')) {
        return 'Ein AAAA-Eintrag zeigt auf eine IPv6-Adresse, z. B. 2001:db8::1.';
      }
      break;
    case 'CNAME':
    case 'NS':
    case 'MX': {
      if (IPV4.test(content)) {
        return `Ein ${input.type}-Eintrag zeigt auf einen Namen, nicht auf eine IP-Adresse.`;
      }
      if (!HOSTNAME.test(content)) return 'Das ist kein gültiger Hostname.';
      break;
    }
    case 'TXT':
      if (content.length > 2048) return 'Der Text ist länger, als ein TXT-Eintrag fassen kann.';
      break;
  }

  // Ein CNAME auf der Zone selbst verdeckt deren NS- und MX-Einträge; Cloudflare
  // baut daraus stillschweigend einen „CNAME flattening"-Fall. Das ist eine
  // Entscheidung, die niemand nebenbei im Dialog treffen sollte.
  if (input.type === 'CNAME' && (name === '@' || name === zoneName.toLowerCase())) {
    return 'Ein CNAME auf der Domain selbst verdeckt ihre NS- und MX-Einträge. Dort gehört ein A-Eintrag hin.';
  }

  if (input.ttl !== TTL_AUTO && (input.ttl < TTL_MIN || input.ttl > TTL_MAX)) {
    return `Die TTL liegt zwischen ${TTL_MIN} und ${TTL_MAX} Sekunden oder auf „automatisch".`;
  }

  if (input.type === 'MX') {
    if (input.priority === null) return 'Ein MX-Eintrag braucht eine Priorität.';
    if (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 65535) {
      return 'Die Priorität ist eine ganze Zahl zwischen 0 und 65535.';
    }
  }

  if (input.proxied && !PROXYABLE_TYPES.includes(input.type)) {
    return `Einträge vom Typ ${input.type} kann Cloudflare nicht über seine Server schicken.`;
  }

  if (input.comment && input.comment.length > 100) {
    return 'Die Notiz fasst 100 Zeichen.';
  }

  return null;
}

/**
 * Was aus einem Formular oder einem Request-Rumpf an Eingabe herauskommt.
 *
 * Dieselbe Funktion für beide Seiten, aus demselben Grund wie
 * `readServiceInput` beim Reverse-Proxy: der Dialog prüft, was er schickt, und
 * die Route prüft, was sie bekommt — mit einem zweiten Leser wären das zwei
 * Normalisierungen, die sich in genau einem Randfall unterscheiden.
 */
export function readRecordInput(raw: Record<string, unknown>): RecordInput {
  const type = String(raw.type ?? '').toUpperCase();
  const priority = Number(raw.priority);
  return {
    // Unbekannte Art bleibt stehen und wird nicht auf `A` zurechtgebogen:
    // `validateRecordInput` soll sie mit ihrem Namen ablehnen können.
    type: type as EditableRecordType,
    name: String(raw.name ?? '').trim().toLowerCase(),
    content: String(raw.content ?? '').trim(),
    ttl: Number.isFinite(Number(raw.ttl)) ? Number(raw.ttl) : TTL_AUTO,
    // Ein `proxied` an einem TXT-Eintrag ist keine Einstellung, sondern ein
    // Fehler — hier fällt es weg, statt später von Cloudflare abgelehnt zu werden.
    proxied: raw.proxied === true && PROXYABLE_TYPES.includes(type),
    priority: type === 'MX' && Number.isFinite(priority) ? priority : null,
    comment: String(raw.comment ?? '').trim() || null,
  };
}

/** Die TTL als Text. `1` ist bei Cloudflare „automatisch" und keine Sekunde. */
export function formatTtl(ttl: number): string {
  if (ttl === TTL_AUTO) return 'auto';
  if (ttl % 3600 === 0) return `${ttl / 3600} h`;
  if (ttl % 60 === 0) return `${ttl / 60} min`;
  return `${ttl} s`;
}
